'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const guildId = '1516358993939922994';
const ownerId = '141947703742562304';
const key = 'fa'.repeat(32);
const token = 'mock-reader-token-0123456789abcdef';

class Builder {
  setName(){return this;} setDescription(){return this;} addSubcommand(fn){fn(new Builder());return this;}
  addIntegerOption(fn){fn(new Builder());return this;} setRequired(){return this;}
  setMinValue(){return this;} setMaxValue(){return this;} toJSON(){return {};}
  setCustomId(id){this.customId=id;return this;} setTitle(){return this;}
  addComponents(){return this;} setLabel(){return this;} setStyle(){return this;}
  setMinLength(){return this;} setMaxLength(){return this;}
}

async function boot() {
  let bot, pool;
  class FakeBot extends EventEmitter {
    constructor(){
      super();bot=this;this.guilds={cache:new Map([[guildId,{
        memberCount:0,ownerId,commands:{create:async()=>{}},members:{fetch:async()=>new Map()},
      }]])};
    }
    isReady(){return !!this.online;}
    async login(){this.online=true;this.emit('clientReady');}
  }
  class FakeDatabase {async connect(){} startLease(){} async loadToken(){return null;}}
  class FakeStore {
    constructor(){this.data={arena:{},clan:{},outbox:[]};}
    async load(){} async flush(){} enqueue(){}
  }
  class FakeMonitor {constructor(){this.clanRevision=0;} reconcileClan(){return true;}}
  class FakeScanner {
    constructor(){this.clanMembers={fetch:async()=>new Map(),invalidate(){}};this.lastDirty=false;this.paused=false;}
  }
  class FakePool {
    constructor(){pool=this;this.busy=false;this.replacements=[];}
    states(){return Array.from({length:5},(_,i)=>({number:i+1,configured:false}));}
    countReady(){return 0;}
    async replace(slot,value,actor){this.replacements.push({slot,value,actor});}
    destroy(){}
  }
  const c={
    botToken:'fake-bot',mongoUri:'mongodb://example.invalid',encryptionKey:key,
    readerTokens:['','','','',''],clanId:guildId,arenaId:'766953289409232896',
    roleId:'1470732413112942665',logId:'1550714406529273936',
    publicScan:true,allowedRoles:[],tokenAdmins:[],interval:300000,
  };
  const discord={Client:FakeBot,GatewayIntentBits:{Guilds:1,GuildMembers:2,GuildMessages:3,MessageContent:4},
    Options:{cacheWithLimits:x=>x,DefaultMakeCacheSettings:{}},PermissionFlagsBits:{ManageGuild:1},
    MessageFlags:{Ephemeral:64},SlashCommandBuilder:Builder,ModalBuilder:Builder,TextInputBuilder:Builder,
    TextInputStyle:{Short:1},ActionRowBuilder:Builder};
  const mocks={
    'discord.js':discord,
    './python-reader':{PythonReader:class extends EventEmitter{},prepareReaderRuntime:async()=>{}},
    './config':{config:()=>c},
    './database':{Database:FakeDatabase,MongoStore:FakeStore},
    './monitor':{Monitor:FakeMonitor},
    './scanner':{Scanner:FakeScanner},
    './reader-pool':{ReaderPool:FakePool},
    './core':{record(){},parseScan(){},newEvent(){return {}},safeError:e=>String(e.message)},
    './ui':{base(){return new Builder();}},
    './jail':{},
  };
  const localRequire=name=>mocks[name]||require(name.startsWith('./')?path.join(__dirname,'../src',name.slice(2)):name);
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/index.js'),'utf8'),{
    require:localRequire,module,exports:module.exports,
    console:{log(){},warn(){},error(){}},
    process:{on(){},env:{},memoryUsage:()=>({rss:1000000})},
    setTimeout:()=>({}),clearTimeout(){},setInterval:()=>({unref(){}}),
  });
  await module.exports.main();
  const dispatch=async interaction=>bot.listeners('interactionCreate')[0](interaction);
  return {bot,pool,dispatch};
}
function interactionBase(user=ownerId){return {guildId,guild:{ownerId},user:{id:user},replied:false,deferred:false};}
async function show(f,slot){
  let id;
  await f.dispatch({...interactionBase(),isChatInputCommand:()=>true,isModalSubmit:()=>false,
    commandName:'تحديث',options:{getSubcommand:()=> 'التوكن',getInteger:()=>slot},
    showModal:async modal=>{id=modal.customId;},
  });
  return id;
}
async function submit(f,id,user=ownerId){
  const replies=[];
  await f.dispatch({...interactionBase(user),isChatInputCommand:()=>false,isModalSubmit:()=>true,
    customId:id,fields:{getTextInputValue:()=>token},
    deferReply:async()=>replies.push('deferred'),
    editReply:async text=>replies.push(text),
    reply:async payload=>replies.push(payload.content),
  });
  return replies;
}

test('real /تحديث handler updates precisely the selected reader',async()=>{
  const f=await boot();
  const modalId=await show(f,4);
  assert.match(modalId,/^reader-token:v1:4:/);
  const replies=await submit(f,modalId);
  assert.equal(f.pool.replacements.length,1);
  assert.deepEqual(f.pool.replacements[0],{slot:4,value:token,actor:ownerId});
  assert.equal(replies[0],'deferred');
  assert.match(replies[1],/القارئ 4 متصل/);
});

test('a modal created by the former process succeeds with a newly booted process',async()=>{
  const original=await boot(), modalId=await show(original,1);
  const rebooted=await boot();
  const replies=await submit(rebooted,modalId);
  assert.equal(rebooted.pool.replacements.length,1);
  assert.equal(rebooted.pool.replacements[0].slot,1);
  assert.match(replies[1],/القارئ 1 متصل/);
});

test('a modal sent by another account is rejected before reading its token',async()=>{
  const f=await boot(),modalId=await show(f,3);
  const replies=await submit(f,modalId,'181947703742562304');
  assert.equal(f.pool.replacements.length,0);
  assert.match(replies[0],/غير مخوّل/);
});
