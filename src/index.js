'use strict';
const {Client,GatewayIntentBits,Options,PermissionFlagsBits,MessageFlags,SlashCommandBuilder,ModalBuilder,TextInputBuilder,TextInputStyle,ActionRowBuilder}=require('discord.js');
const {PythonReader,prepareReaderRuntime}=require('./python-reader');
const {randomBytes}=require('node:crypto');
const {createTokenModalId,verifyTokenModalId}=require('./token-modal');
const {config}=require('./config');
const {Database,MongoStore}=require('./database');
const {Monitor}=require('./monitor');
const {Scanner}=require('./scanner');
const {ReaderPool}=require('./reader-pool');
const {record,parseScan,newEvent,safeError}=require('./core');
const {base,pages,reportPayload,eventPayload,exportReport}=require('./ui');
const {jailPages,jailPayload,exportJail}=require('./jail');

async function main(){
  const c=config(),readerEnvTokens=c.readerTokens || [c.readerToken],secrets=[c.botToken,...readerEnvTokens,c.mongoUri,c.encryptionKey];
  const logError=(label,e)=>console.error(`[${label}] ${safeError(e,secrets)}`);
  const database=new Database(c);await database.connect();
  const store=new MongoStore(database);await store.load();const monitor=new Monitor(store,c);
  const bot=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],
    makeCache:Options.cacheWithLimits({...Options.DefaultMakeCacheSettings,MessageManager:0}),allowedMentions:{parse:[],repliedUser:false},rest:{timeout:20000,retries:2}});
  const makeReader=()=>new PythonReader({arenaId:c.arenaId,python:c.python});
  const scanner=new Scanner(bot,null,c,monitor),sessions=new Map(),commandsSeen=new Map();
  const sessionPayload=(s,id,disabled=false)=>s.kind==='jail'?jailPayload(c,s.report,s.page,id,disabled):reportPayload(c,s.report,s.custom,s.page,id,disabled);
  const sessionPages=s=>s.kind==='jail'?jailPages(s.report):pages(s.report,s.custom);
  let initializingClan=null;
  let stopping=false,pumping=false,nextPump=0,pumpFailures=0,started=false,periodicRunning=false,clanReady=false,persistTimer;
  let botConnection='جاري الاتصال',lastReconcileError='';
  function authorized(member){return c.publicScan||staff(member);}
  function staff(member){return !!member?.permissions?.has(PermissionFlagsBits.ManageGuild)||c.allowedRoles.some(id=>member?.roles?.cache?.has(id));}
  function tokenAdmin(id,guild){return id===guild.ownerId||c.tokenAdmins.includes(id);}
  function schedulePersist(){if(!persistTimer)persistTimer=setTimeout(()=>{persistTimer=null;store.flush().catch(e=>logError('database-save',e));},1000);}
  function enqueueSystem(text){store.enqueue(newEvent('system',null,'reconcile',{text}));schedulePersist();}
  async function shutdown(code=0){
    if(stopping)return;stopping=true;clearTimeout(persistTimer);const timer=setTimeout(()=>process.exit(code||1),12000);
    try{await store.flush();}catch(e){logError('save-on-exit',e);code=1;}
    bot.destroy();pool.destroy();try{await database.close();}catch(e){logError('database-close',e);}clearTimeout(timer);process.exit(code);
  }
  function fatal(label,e){logError(label,e);shutdown(1);}
  database.startLease(e=>fatal('worker-lease',e));
  async function pump(){
    if(pumping||stopping||!bot.isReady()||!store.data.outbox.length||Date.now()<nextPump)return;pumping=true;
    try{const channel=await bot.channels.fetch(c.logId);if(!channel?.isTextBased()||channel.guildId!==c.clanId)throw new Error('شات اللوق غير صحيح أو خارج الكلان.');
      for(let i=0;i<10&&store.data.outbox.length;i++){const e=store.data.outbox[0];await store.flush();await channel.send(eventPayload(c,e));store.data.outbox.shift();await store.flush();}pumpFailures=0;
    }catch(e){pumpFailures++;nextPump=Date.now()+Math.min(300000,5000*2**Math.min(pumpFailures,6));logError('log-queue',e);}finally{pumping=false;}
  }
  async function reconcile(){
    if(periodicRunning||stopping||!bot.isReady()||scanner.paused)return;
    if(!clanReady){await initializeClan();if(!clanReady)return;}
    if(!pool.countReady())return;periodicRunning=true;
    try{if(scanner.active&&scanner.active.roleId!==c.roleId)return;await scanner.scan(c.roleId);store.data.arenaInitialized=true;lastReconcileError='';
      for(const [id,s] of Object.entries(store.data.arena))if(!s.role&&!store.data.clan[id]&&Date.now()-s.at>30*86400000)delete store.data.arena[id];
      await store.flush();await pump();
    }catch(e){lastReconcileError=safeError(e,secrets);logError('reconcile',e);}finally{periodicRunning=false;}
  }
  function maybeStart(){if(!clanReady||!bot.isReady()||!pool.countReady())return;if(!started){started=true;enqueueSystem('❄️ **بدأت مراقبة SNOW — 2.2.0**\n`!scan` للرتب · `!سجن` للسجن والإنذارات · `!status` للاتصال.\nالقارئ: discord.py-self؛ تتم مراجعة العضوية والرتب عبر البيانات المتاحة.');}reconcile().catch(e=>logError('start',e));}
  bot.on('error', e=>logError('clan',e));
  bot.on('shardError',e=>logError('clan-socket',e));
  bot.on('shardDisconnect',e=>{botConnection=`منقطع (${e.code})`;scanner.lastDirty=true;scanner.clanMembers.invalidate();});
  bot.on('shardReconnecting',()=>{botConnection='يعيد الاتصال';scanner.lastDirty=true;});
  bot.on('invalidated',()=>{botConnection='الجلسة غير صالحة';scanner.lastDirty=true;});
  bot.on('shardResume',()=>{botConnection='متصل';scanner.lastDirty=true;maybeStart();});
  const pool=new ReaderPool({makeClient:makeReader,database,arenaId:c.arenaId,scanner,
    onSecret: token=>secrets.push(token),
    onChange:()=>maybeStart(),
    onClient:(number,client)=>{
      const current=()=>pool.isCurrent(number,client);
      client.on('error',e=>{if(current())logError(`reader-${number}`,e);});
      client.on('ready',()=>{if(!current())return;pool.notify(number,client,'');maybeStart();});
      client.on('stopped',code=>{if(current())pool.notify(number,client,`متوقف: ${code}`);});
      client.on('invalidated',()=>{if(current())pool.notify(number,client,`غير متصل: ${client.disabledCode||'جلسة غير صالحة'}`);});
      client.on('member',data=>{
        if(!current())return;
        try{
          if(!store.data.clan[data.id]&&!store.data.arena[data.id]&&!data.roles?.includes(c.roleId))return;
          scanner.observe(data);monitor.arena(data,'live');schedulePersist();
        }catch(e){fatal('member-event',e);}
      });
      client.on('roleDelete',role=>{
        if(!current()||role.guild.id!==c.arenaId||role.id!==c.roleId||scanner.roleDeleted)return;
        scanner.roleDeleted=true;
        enqueueSystem('❌ حُذفت رتبة الكلان في أرينا. حدّث إعداد CLAN_ROLE_ID.');
        for(const state of Object.values(store.data.arena))state.role=false;
        scanner.lastDirty=true;
      });
    },
  });
  scanner.readerProvider=()=>pool.nextReader();
  async function initializeClan(){
    if(initializingClan)return initializingClan;
    initializingClan=(async()=>{
      try{
        const guild=bot.guilds.cache.get(c.clanId);if(!guild)throw new Error('أضف البوت إلى سيرفر الكلان.');
        const command=new SlashCommandBuilder().setName('تحديث').setDescription('تحديث إعدادات القارئ')
          .addSubcommand(sub=>sub.setName('التوكن').setDescription('تحديث توكن قارئ محدد في نافذة خاصة')
            .addIntegerOption(option=>option.setName('القارئ').setDescription('اختر رقم القارئ من 1 إلى 5').setRequired(true).setMinValue(1).setMaxValue(5)));
        const check=new SlashCommandBuilder().setName('حالة').setDescription('التحقق من اتصال القراء الخمسة');
        await Promise.all([command,check].map(item=>guild.commands.create(item.toJSON()).catch(e=>logError('slash-registration',e))));
        const revision=monitor.clanRevision,members=await scanner.clanMembers.fetch(guild);
        if(members.size!==guild.memberCount||!monitor.reconcileClan(new Map([...members].map(([id,m])=>[id,record(m)])),revision))throw new Error('لم تكتمل قائمة الكلان أو تغيرت أثناء التهيئة.');
        clanReady=true;schedulePersist();
      }catch(e){logError('bot-init',e);}
    })().finally(()=>{initializingClan=null;});return initializingClan;
  }
  bot.on('clientReady',async()=>{botConnection='متصل';clanReady=false;scanner.clanMembers.invalidate();await initializeClan();maybeStart();});
  bot.on('guildMemberAdd',m=>{if(m.guild.id!==c.clanId)return;scanner.clanMembers.invalidate();monitor.clan(m.id,true,'live',record(m));scanner.lastDirty=true;schedulePersist();});
  bot.on('guildMemberRemove',m=>{if(m.guild.id!==c.clanId)return;scanner.clanMembers.invalidate();monitor.clan(m.id,false,'live',{bot:m.user?.bot,avatar:m.user?.displayAvatarURL()});scanner.lastDirty=true;schedulePersist();});
  function readerLines(){return pool.states().map(s=>`**القارئ ${s.number}:** ${s.connected?'🟢':s.configured?'🔴':'⚪'} ${s.detail}`).join('\n');}
  function readerStatus(){return base(c,'📡 حالة القراء الخمسة').setDescription(`${readerLines()}\n\n**المتصلون:** ${pool.countReady()} من 5\n**آخر قارئ استُخدم:** ${pool.lastUsed||'لا يوجد'}\n\nيُفحص الاتصال فعليًا، وليس مجرد وجود توكن.`);}
  function status(){const last=scanner.last;return base(c,'📡 حالة مراقبة SNOW — 2.2.0').setDescription(`**البوت:** ${botConnection}\n**القراء المتصلون:** ${pool.countReady()} من 5\n${readerLines()}\n**المكتبة:** discord.py-self 2.1.0\n**الفحص:** ${scanner.active?'جارٍ':scanner.health}\n**MongoDB:** ${store.lastError?'تعذّر آخر حفظ؛ يجري إعادة المحاولة':'آخر حفظ ناجح'}\n**آخر فحص:** ${last?`<t:${Math.floor(last.finished/1000)}:R>`:'لم يكتمل'}\n**اللوق المنتظر:** ${store.data.outbox.length}\n**الذاكرة:** ${Math.round(process.memoryUsage().rss/1048576)} MB\n${lastReconcileError?'⚠️ '+lastReconcileError:''}\n\nالرصد يقتصر على العضوية والرتب؛ لا يوجد تتبع للرسائل أو الصوت.`);}
  bot.on('messageCreate',async message=>{
    if(message.author.bot||message.guildId!==c.clanId)return;
    const command=message.content.trim().split(/\s+/)[0].toLowerCase();if(!['!scan','!status','!help','!سجن'].includes(command))return;
    if(c.commandChannel&&message.channelId!==c.commandChannel)return;
    if(message.id&&commandsSeen.has(message.id))return;
    if(message.id){if(commandsSeen.size>=5000)commandsSeen.delete(commandsSeen.keys().next().value);commandsSeen.set(message.id,Date.now()+15*60000);}
    const respond=payload=>message.reply({...payload,...(message.id?{nonce:message.id,enforceNonce:true}:{})});let pending;
    try{
      if(!(command==='!سجن'?staff(message.member):authorized(message.member)))throw new Error('الأمر لإدارة السيرفر أو الرتب المسموح لها.');
      if(command==='!status'){await respond({embeds:[status()]});return;}
      if(command==='!help'){await respond({embeds:[base(c,'❄️ أوامر SNOW').setDescription('`!scan` — فحص الرتبة\n`!scan ROLE_ID` — فحص رتبة أخرى\n`!سجن` — حاملو رتبة الكلان المسجونون أو أصحاب الإنذار\n`/تحديث التوكن القارئ:1..5` — لتحديث القارئ المحدد\n`/حالة` — اتصال القراء الخمسة\n`!status` — حالة الاتصال والحفظ')]});return;}
      if(!clanReady)throw new Error('جاري تهيئة بيانات الكلان. جرّب بعد قليل.');
      if(command==='!سجن'){
        if(message.content.trim()!=='!سجن')throw new Error('اكتب !سجن فقط لعرض السجن والإنذارات.');
        pending=await respond({embeds:[base(c,'🔎 جاري فحص السجن والإنذارات…')]});
        const report=await scanner.scan(c.roleId,{force:true});
        store.data.arenaInitialized=true;
        const id=randomBytes(6).toString('hex');if(sessions.size>=100)sessions.delete(sessions.keys().next().value);
        const s={kind:'jail',owner:message.author.id,roleId:c.roleId,report,page:0,message:pending,expires:Date.now()+15*60000,busy:false};
        sessions.set(id,s);await pending.edit(sessionPayload(s,id));return;
      }
      const {roleId,custom}=parseScan(message.content,c.roleId);pending=await respond({embeds:[base(c,'🔎 جاري فحص الأعضاء…')]});
      const report=await scanner.scan(roleId);if(roleId===c.roleId)store.data.arenaInitialized=true;
      const id=randomBytes(6).toString('hex');if(sessions.size>=100)sessions.delete(sessions.keys().next().value);
      sessions.set(id,{owner:message.author.id,roleId,custom,report,page:0,message:pending,expires:Date.now()+15*60000,busy:false});await pending.edit(reportPayload(c,report,custom,0,id));
    }catch(e){logError('command',e);const payload={embeds:[base(c,'⚠️ لم يكتمل الطلب',0xF6BA4B).setDescription(safeError(e,secrets))],components:[]};await(pending?pending.edit(payload):respond(payload)).catch(err=>logError('reply',err));}
  });
  bot.on('interactionCreate',async i=>{
    try{
      if(i.guildId!==c.clanId)return;
      if(i.isChatInputCommand()&&i.commandName==='حالة'){
        if(!tokenAdmin(i.user.id,i.guild)){await i.reply({content:'فحص القراء لصاحب السيرفر أو المعرّفات المخوّلة فقط.',flags:MessageFlags.Ephemeral});return;}
        await i.reply({embeds:[readerStatus()],flags:MessageFlags.Ephemeral});return;
      }
      if(i.isChatInputCommand()&&i.commandName==='تحديث'&&i.options.getSubcommand()==='التوكن'){
        if(!tokenAdmin(i.user.id,i.guild)){await i.reply({content:'تحديث التوكن لصاحب السيرفر أو المعرّفات المخوّلة في TOKEN_ADMIN_IDS فقط.',flags:MessageFlags.Ephemeral});return;}
        if(pool.busy){await i.reply({content:'يوجد تحديث جارٍ الآن.',flags:MessageFlags.Ephemeral});return;}
        const slot=i.options.getInteger('القارئ',true);
        const modalId=createTokenModalId({slot,userId:i.user.id,guildId:i.guildId,key:c.encryptionKey});
        const modal=new ModalBuilder().setCustomId(modalId).setTitle(`تحديث توكن القارئ ${slot}`).addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('token').setLabel('توكن حسابك الموجود في أرينا').setStyle(TextInputStyle.Short).setMinLength(20).setMaxLength(300).setRequired(true)));
        await i.showModal(modal);return;
      }
      if(i.isModalSubmit()&&i.customId.startsWith('reader-token:')){
        const slot=verifyTokenModalId({customId:i.customId,userId:i.user.id,guildId:i.guildId,key:c.encryptionKey});
        if(!slot||!tokenAdmin(i.user.id,i.guild)){await i.reply({content:'النافذة منتهية أو غير مخوّل. افتح /تحديث التوكن مجددًا.',flags:MessageFlags.Ephemeral});return;}
        await i.deferReply({flags:MessageFlags.Ephemeral});
        try{await pool.replace(slot,i.fields.getTextInputValue('token'),i.user.id);await i.editReply(`✅ القارئ ${slot} متصل، وحُفظ توكنه مشفّرًا في MongoDB. لن يتغير أي قارئ آخر.`);enqueueSystem(`🔐 تم تحديث اتصال القارئ ${slot} بواسطة <@${i.user.id}>.`);reconcile().catch(e=>logError('after-token',e));}
        catch(e){logError('token-update',e);await i.editReply('❌ '+safeError(e,secrets)+'\nإذا لم ينجح التحقق والحفظ، يبقى القارئ السابق كما هو.');}return;
      }
      if(!(i.isButton()||i.isStringSelectMenu()))return;
      if(!i.customId.startsWith('scan:'))return;
      const [,id,action]=i.customId.split(':'),s=sessions.get(id);
      if(!s||s.expires<Date.now()){await i.reply({content:'انتهت صلاحية التقرير. أعد كتابة !scan أو !سجن.',flags:MessageFlags.Ephemeral});return;}
      if(s.owner!==i.user.id||!(s.kind==='jail'?staff(i.member):authorized(i.member))){await i.reply({content:'الأزرار لصاحب الفحص المخوّل.',flags:MessageFlags.Ephemeral});return;}
      if(s.busy){await i.reply({content:'انتظر انتهاء التحديث.',flags:MessageFlags.Ephemeral});return;}
      if(action==='export'){await i.reply({files:[s.kind==='jail'?exportJail(c,s.report):exportReport(s.report,s.custom)],flags:MessageFlags.Ephemeral});return;}
      s.busy=true;try{await i.deferUpdate();if(action==='refresh'){s.report=await scanner.scan(s.roleId,{force:true});s.page=0;}else if(action==='next')s.page++;else if(action==='prev')s.page--;s.page=Math.max(0,Math.min(s.page,sessionPages(s)-1));await i.editReply(sessionPayload(s,id));}
      catch(e){if(i.deferred)await i.followUp({content:safeError(e,secrets),flags:MessageFlags.Ephemeral});else throw e;}finally{s.busy=false;}
    }catch(e){logError('interaction',e);if(!i.replied&&!i.deferred)await i.reply({content:'تعذّر إتمام الطلب؛ أعد المحاولة.',flags:MessageFlags.Ephemeral}).catch(()=>{});}
  });
  setInterval(()=>pump().catch(e=>logError('pump',e)),2000).unref();
  setInterval(()=>reconcile().catch(e=>logError('periodic',e)),c.interval).unref();
  setInterval(()=>{store.flush().catch(e=>logError('checkpoint',e));},30000).unref();
  setInterval(()=>{
    for(const [id,s] of sessions)if(s.expires<Date.now()&&!s.busy){sessions.delete(id);s.message.edit(sessionPayload(s,id,true)).catch(()=>{});}
    for(const [id,until] of commandsSeen)if(until<=Date.now())commandsSeen.delete(id);
    console.log(`[health] bot=${bot.isReady()} readers=${pool.countReady()}/5 rss=${Math.round(process.memoryUsage().rss/1048576)}MB outbox=${store.data.outbox.length}`);
  },60000).unref();
  process.on('SIGINT',()=>shutdown());process.on('SIGTERM',()=>shutdown());process.on('unhandledRejection',e=>fatal('unhandled',e));process.on('uncaughtException',e=>fatal('uncaught',e));
  await prepareReaderRuntime(c.python);
  await bot.login(c.botToken);
  // Boot every slot independently: a failed login does not prevent the others.
  await Promise.all(Array.from({length:5},async(_,index)=>{
    const number=index+1;
    let token;
    try{token=await database.loadToken(number);}catch(e){logError(`stored-token-${number}`,new Error('تعذّر فك التوكن المحفوظ؛ تأكد من ENCRYPTION_KEY.'));}
    token ||= readerEnvTokens[index];
    if(!token)return;
    const connected=await pool.boot(number,token);
    if(!connected)console.warn(`[reader-${number}] تعذر الاتصال؛ تحقق من /حالة.`);
  }));
  if(!pool.states().some(s=>s.configured))console.log('[readers] استخدم /تحديث التوكن القارئ:1..5 لربط القراء.');
}
if(require.main===module)main().catch(e=>{console.error(safeError(e,[process.env.DISCORD_BOT_TOKEN,...Array.from({length:5},(_,i)=>process.env[`READER_TOKEN_${i+1}`]),process.env.READER_TOKEN,process.env.MONGODB_URI,process.env.ENCRYPTION_KEY]));process.exitCode=1;setTimeout(()=>process.exit(1),100);});
module.exports={main};
