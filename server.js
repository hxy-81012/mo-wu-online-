const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const CARD_DEFS = {
  attack:    {name:'攻击',   type:'atk', cd:0, once:false, desc:'声明上/中/下，命中造成武器基础伤害。'},
  block:     {name:'格挡',   type:'def', cd:0, once:false, desc:'若本次攻击命中，则完全免疫。计入格挡成功。'},
  advance:   {name:'前进',   type:'mov', cd:0, once:false, desc:'向对方前进1格；距离已为1则移动无效。速度+1。'},
  retreat:   {name:'后退',   type:'mov', cd:0, once:false, desc:'远离对方1格。速度+1。'},
  jump:      {name:'跳跃',   type:'def', cd:1, once:false, desc:'免疫下段；下次行动速度+1；下次攻击距离为1时必中。'},
  crouch:    {name:'下蹲',   type:'def', cd:0, once:false, desc:'免疫中段与上段。'},
  charge:    {name:'冲锋',   type:'atk', cd:0, once:true,  desc:'前进至距离1；速度+3；下次攻击伤害+2。'},
  backstep:  {name:'后撤步', type:'def', cd:0, once:true,  desc:'后退3格；速度+3；下回合速度+2；下次攻击伤害+1。'},
  lingbo:    {name:'凌波微步',type:'utl',cd:0, once:true,  desc:'攻击回合：下次攻击+1、下次行动速度+3、下次攻击必中。防御回合：本回合免疫中/下，下回合速度+2，下次攻击+1。'},
  sweep:     {name:'扫堂腿', type:'utl', cd:0, once:true,  desc:'攻击回合：速度+3，下次攻击+2，命中则敌下回合不能跳/蹲。防御回合：本回合免疫中/上，对敌造成0.5伤害。'},
  heavy:     {name:'重劈',   type:'atk', cd:2, once:false, desc:'攻击一次；若命中视为命中两次；若触发刀特性则额外+1伤害。'},
  parry:     {name:'横刀招架',type:'def',cd:0, once:true,  desc:'若对方攻击命中则免疫；回复已触发刀特性次数×2血量；对敌0.5伤害。不计入盾特性。'},
  shieldbash:{name:'盾击',   type:'utl', cd:3, once:false, desc:'对敌强制造成1伤害；视作使用一次格挡；下个防御回合无法使用格挡。'},
  feast:     {name:'盛宴',   type:'utl', cd:0, once:true,  desc:'血量+5，上限15。'},
  crit:      {name:'会心',   type:'utl', cd:3, once:false, desc:'本大回合速度+2。'},
  critstrike:{name:'会心一击',type:'atk',cd:0, once:true,  desc:'本次攻击伤害+3，必定命中。'},
  relay:     {name:'接力',   type:'utl', cd:4, once:false, desc:'本大回合速度保留至下回合，无视攻击清空与回合结束清空。'},
};

const WEAPONS = {
  blade: {name:'刀 · 盾', base:1},
  spear: {name:'长枪',   base:1.5}
};

let uidC = 0;
function makeDeck(w){
  const D = [];
  const add = (key, opts) => {
    const def = CARD_DEFS[key];
    D.push(Object.assign({uid:'c'+(++uidC), key, cdLeft:0, removed:false}, def, opts||{}));
  };
  add('attack',{cd:2}); add('attack',{cd:2}); add('attack',{cd:3});
  if(w==='spear'){ add('crit'); add('crit'); add('crit'); }
  else { add('block',{cd:2}); add('block',{cd:2}); add('block',{cd:3}); }
  add('advance'); add('advance');
  add('retreat'); add('retreat');
  add('jump'); add('jump');
  add('crouch'); add('crouch');
  add('charge'); add('backstep'); add('lingbo'); add('sweep');
  if(w==='blade'){ add('heavy'); add('parry'); add('shieldbash'); add('feast'); }
  else { add('critstrike'); add('relay'); }
  return D;
}function createPlayer(idx, weapon){
  return {
    idx, weapon,
    name: idx===0 ? '侠客 · 甲' : '侠客 · 乙',
    hp: 15,
    permSpeed: 0, tempSpeed: 0,
    keepSpeed: 0, nextRoundSpeed: 0, nextActSpeed: 0,
    nextAtkBonus: 0, nextSure: false,
    bladeHits: 0, bladeTriggers: 0, rusted: false, rustBonus: 0,
    blockSuccess: 0, rebuilt: false,
    spearAtkCount: 0,
    lastStandActive: false,
    noBlock: false, noJumpCrouch: false,
    deck: makeDeck(weapon),
    hand: [], revealed: []
  };
}

const rooms = new Map();

function genRoomId(){
  let id;
  do { id = Math.random().toString(36).slice(2,6).toUpperCase(); } while(rooms.has(id));
  return id;
}

function newRoom(){
  const id = genRoomId();
  const room = {
    id,
    sockets: [null, null],
    game: null,
    waitings: {}
  };
  rooms.set(id, room);
  return room;
}

function fmt(n){
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  return n.toFixed(1);
}
function other(i){ return i === 0 ? 1 : 0; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(room, html, cls){
  if (!room.game.log) room.game.log = [];
  room.game.log.push({html, cls: cls||''});
  if (room.game.log.length > 120) room.game.log.shift();
}

function playerPublic(p, isMe){
  if (!p) return null;
  return {
    idx: p.idx, name: p.name, weapon: p.weapon, hp: p.hp,
    permSpeed: p.permSpeed, tempSpeed: p.tempSpeed,
    bladeHits: p.bladeHits, bladeTriggers: p.bladeTriggers,
    rusted: p.rusted, rustBonus: p.rustBonus,
    blockSuccess: p.blockSuccess, rebuilt: p.rebuilt,
    spearAtkCount: p.spearAtkCount,
    lastStandActive: p.lastStandActive,
    nextAtkBonus: p.nextAtkBonus, nextSure: p.nextSure,
    noBlock: p.noBlock, noJumpCrouch: p.noJumpCrouch,
    hand: p.hand.map((c, i) => {
      if (!c) return null;
      if (p.revealed[i] || isMe){
        return {uid:c.uid, key:c.key, name:c.name, type:c.type, cd:c.cd, desc:c.desc};
      }
      return {back:true};
    }),
    revealed: p.revealed
  };
}

function stateFor(room, idx){
  const g = room.game;
  if (!g || !g.players || (!g.players[0] && !g.players[1])){
    return {phase: g ? g.phase : 'waiting', roomId: room.id, myIdx: idx, waitingFor: []};
  }
  const wf = (g.waitingFor || []).map(w => {
    const o = {idx: w.idx, type: w.type};
    if (w.idx === idx && w.available) o.available = w.available;
    return o;
  });
  return {
    phase: g.phase,
    roomId: room.id,
    myIdx: idx,
    attackerIdx: g.attackerIdx,
    distance: g.distance,
    roundNo: g.roundNo,
    log: (g.log||[]).slice(-80),
    waitingFor: wf,
    me: playerPublic(g.players[idx], true),
    opp: playerPublic(g.players[other(idx)], false),
    gameOver: g.gameOver || null
  };
}

function broadcastState(room){
  [0,1].forEach(i => {
    const sid = room.sockets[i];
    if (sid) io.to(sid).emit('state', stateFor(room, i));
  });
}

function waitFor(room, idx, type){
  return new Promise(resolve => {
    room.waitings[idx] = {type, resolve};
  });
}

async function ask(room, idx, type, extra){
  const wf = Object.assign({idx, type}, extra||{});
  if (!room.game.waitingFor) room.game.waitingFor = [];
  room.game.waitingFor.push(wf);
  const promise = waitFor(room, idx, type);
  broadcastState(room);
  const data = await promise;
  room.game.waitingFor = room.game.waitingFor.filter(w => w !== wf);
  return data;
}

async function askPick(room, idx){
  const p = room.game.players[idx];
  const avail = p.deck.filter(c => !c.removed && c.cdLeft <= 0);
  const available = avail.map(c => ({
    uid:c.uid, key:c.key, name:c.name, type:c.type,
    cd:c.cd, once:c.once, desc:c.desc
  }));
  const uids = await ask(room, idx, 'pick', {available});
  const hand = uids.map(u => avail.find(c => c.uid === u)).filter(Boolean);
  return hand;
}function tickCooldowns(p){
  p.deck.forEach(c => { if (c.cdLeft > 0) c.cdLeft--; });
}
function beforeAction(p){
  if (p.nextActSpeed){
    p.tempSpeed += p.nextActSpeed;
    p.nextActSpeed = 0;
  }
}
function baseDamageOf(p){
  let b = WEAPONS[p.weapon].base;
  if (p.weapon === 'blade' && p.rusted) b += p.rustBonus;
  return b;
}
function totalSpeed(p){ return p.permSpeed + p.tempSpeed; }
function computeDamage(p, extra){
  let dmg = baseDamageOf(p);
  dmg += totalSpeed(p) * 0.5;
  dmg += p.nextAtkBonus;
  dmg += (extra || 0);
  return dmg;
}
function makeAttack(P, part, opts){
  opts = opts || {};
  const dmg = computeDamage(P, opts.bonus || 0);
  const sure = opts.sure || P.nextSure;
  P.nextSure = false;
  P.nextAtkBonus = 0;
  return {
    part, damage: dmg, sure: !!sure,
    spearSure: !!sure && P.weapon === 'spear',
    double: !!opts.double,
    source: opts.source || 'attack'
  };
}
function partName(p){ return p === 'up' ? '上' : p === 'mid' ? '中' : '下'; }
function dealDamage(target, amount){
  if (amount <= 0) return;
  target.hp -= amount;
  target.hp = Math.max(-99, target.hp);
}
function onAttackCardPlayed(room, p){
  if (p.weapon !== 'spear') return;
  p.spearAtkCount++;
  if (p.spearAtkCount % 2 === 0 && p.permSpeed < 10){
    p.permSpeed++;
    log(room, `　枪势：永久速度 +1（现 ${p.permSpeed}）`, 'b');
  }
}
function onHitLanded(room, attacker, hits, target){
  if (attacker.weapon !== 'blade') return;
  for (let i = 0; i < hits; i++){
    attacker.bladeHits++;
    if (!attacker.rusted){
      if (attacker.bladeHits % 3 === 0){
        attacker.bladeTriggers++;
        dealDamage(target, 3);
        log(room, `　刀势触发：额外造成 3 点伤害（累计触发 ${attacker.bladeTriggers} 次）`, 'k');
        if (attacker.bladeTriggers >= 3){
          attacker.rusted = true;
          log(room, `　锈蚀殆尽：刀之特性已改写。`, 'y');
        }
      }
    } else {
      if (attacker.rustBonus < 5){
        attacker.rustBonus++;
        log(room, `　锈蚀：基础伤害 +1（现 +${attacker.rustBonus}）`, 'y');
      }
    }
  }
}
function onBlockSuccess(room, D, O){
  if (D.weapon !== 'blade') return;
  D.blockSuccess++;
  if (!D.rebuilt && D.blockSuccess % 3 === 0){
    D.hp = Math.min(15, D.hp + 2);
    log(room, `　盾之特性：格挡成功 3 次，回复 2 点血量。`, 'y');
  }
  if (D.rebuilt && D.blockSuccess % 3 === 0){
    dealDamage(O, 2);
    log(room, `　重新拼装：对敌造成 2 点伤害。`, 'y');
  }
  if (!D.rebuilt && D.blockSuccess >= 6){
    D.rebuilt = true;
    log(room, `　重新拼装：盾之特性已改写。`, 'y');
  }
}
function onParry(room, D, A){
  if (D.weapon !== 'blade') return;
  const heal = D.bladeTriggers * 2;
  if (heal > 0){
    D.hp = Math.min(15, D.hp + heal);
    log(room, `　横刀招架：回复 ${heal} 点血量（现 ${fmt(D.hp)}）`, 'y');
  }
  dealDamage(A, 0.5);
  log(room, `　横刀招架：对敌造成 0.5 点伤害`);
}
function applyHit(room, A, D, atk){
  const hits = atk.double ? 2 : 1;
  let total = 0;
  for (let i = 0; i < hits; i++) total += atk.damage;
  dealDamage(D, total);
  log(room, `　命中！造成 ${fmt(total)} 点伤害（${D.name} 血量 ${fmt(Math.max(0, D.hp))}）`, 'k');
  onHitLanded(room, A, hits, D);
  if (atk.source === 'heavy' && A.weapon === 'blade' && A.bladeHits % 3 === 0 && A.bladeHits > 0){
    dealDamage(D, 1);
    log(room, `　重劈余劲：额外 1 点伤害`);
  }
  if (A._sweepHit){
    D.noJumpCrouch = true;
    A._sweepHit = false;
    log(room, `　扫堂腿命中，${D.name} 下回合无法跳跃与下蹲。`);
  }
}async function resolveAttackSide(room, P, O, card){
  beforeAction(P);
  log(room, `${P.name} 出 ${card.name}`, 'k');
  switch (card.key){
    case 'attack': {
      onAttackCardPlayed(room, P);
      const part = await ask(room, P.idx, 'part');
      const atk = makeAttack(P, part, {source:'attack'});
      log(room, `　攻其「${partName(part)}」，伤害 ${fmt(atk.damage)}${atk.sure?'（必中）':''}`);
      return atk;
    }
    case 'heavy': {
      onAttackCardPlayed(room, P);
      const part = await ask(room, P.idx, 'part');
      const atk = makeAttack(P, part, {double:true, source:'heavy'});
      log(room, `　重劈·攻其「${partName(part)}」，伤害 ${fmt(atk.damage)}${atk.sure?'（必中）':''}`);
      return atk;
    }
    case 'critstrike': {
      onAttackCardPlayed(room, P);
      const part = await ask(room, P.idx, 'part');
      const atk = makeAttack(P, part, {bonus:3, sure:true, source:'critstrike'});
      log(room, `　会心一击·攻其「${partName(part)}」，伤害 ${fmt(atk.damage)}（必中）`);
      return atk;
    }
    case 'charge': {
      room.game.distance = 1;
      P.tempSpeed += 3; P.nextAtkBonus += 2;
      log(room, `　冲锋：距离归 1，速度 +3，下次攻击 +2`, 'g');
      return null;
    }
    case 'sweep': {
      P.tempSpeed += 3; P.nextAtkBonus += 2; P._sweepHit = true;
      log(room, `　扫堂腿（攻）：速度 +3，下次攻击 +2`, 'g');
      return null;
    }
    case 'lingbo': {
      P.nextAtkBonus += 1; P.nextActSpeed += 3; P.nextSure = true;
      log(room, `　凌波微步（攻）：下次攻击 +1、行动速度 +3、必中`, 'g');
      return null;
    }
    case 'advance': {
      if (room.game.distance > 1){ room.game.distance = Math.max(1, room.game.distance-1); log(room, `　前进：距离 → ${room.game.distance}`); }
      else log(room, `　前进：距离已为 1，移动无效`);
      P.tempSpeed += 1; return null;
    }
    case 'retreat': {
      room.game.distance += 1; P.tempSpeed += 1;
      log(room, `　后退：距离 → ${room.game.distance}，速度 +1`);
      return null;
    }
    case 'crouch': log(room, `　下蹲：静观其变`); return null;
    case 'jump': {
      P.nextActSpeed += 1; P.nextSure = true;
      log(room, `　跳跃：下次行动速度 +1，下次攻击必中`);
      return null;
    }
    case 'shieldbash': {
      log(room, `　盾击：强制造成 1 点伤害`, 'k');
      dealDamage(O, 1); P.noBlock = true; return null;
    }
    case 'feast': {
      P.hp = Math.min(15, P.hp + 5);
      log(room, `　盛宴：血量 +5（现 ${fmt(P.hp)}）`, 'y');
      return null;
    }
    case 'crit': {
      P.tempSpeed += 2; log(room, `　会心：速度 +2`, 'b'); return null;
    }
    case 'relay': {
      P.keepSpeed = 1; log(room, `　接力：本回合速度将保留至下回合`, 'b'); return null;
    }
    case 'parry': log(room, `　横刀招架：静候来招`); return null;
    default: return null;
  }
}

async function resolveDefenseSide(room, D, A, card, atk){
  beforeAction(D);
  log(room, `${D.name} 出 ${card.name}`, 'b');
  let immuneByMove = false;
  let parryUsed = false;

  switch (card.key){
    case 'block': break;
    case 'crouch': if (atk && (atk.part==='mid'||atk.part==='up')) immuneByMove = true; break;
    case 'jump': {
      if (atk && atk.part==='down') immuneByMove = true;
      D.nextActSpeed += 1; D.nextSure = true;
      log(room, `　跳跃：下次行动速度 +1，下次攻击必中`);
      break;
    }
    case 'lingbo': {
      if (atk && (atk.part==='mid'||atk.part==='down')) immuneByMove = true;
      D.tempSpeed += 2; D.nextAtkBonus += 1;
      log(room, `　凌波微步（守）：本回合免疫中/下，速度 +2，下次攻击 +1`, 'g');
      break;
    }
    case 'sweep': {
      if (atk && (atk.part==='mid'||atk.part==='up')) immuneByMove = true;
      log(room, `　扫堂腿（守）：本回合免疫中/上，反击 0.5 点`, 'g');
      dealDamage(A, 0.5);
      break;
    }
    case 'parry': parryUsed = true; break;
    case 'backstep': {
      room.game.distance += 3; D.tempSpeed += 3; D.nextRoundSpeed += 2; D.nextAtkBonus += 1;
      log(room, `　后撤步：距离 → ${room.game.distance}，速度 +3，下回合速度 +2，下次攻击 +1`);
      break;
    }
    case 'advance': {
      if (room.game.distance > 1){ room.game.distance = Math.max(1, room.game.distance-1); log(room, `　前进：距离 → ${room.game.distance}`); }
      else log(room, `　前进：距离已为 1，移动无效`);
      D.tempSpeed += 1; break;
    }
    case 'retreat': {
      room.game.distance += 1; D.tempSpeed += 1;
      log(room, `　后退：距离 → ${room.game.distance}，速度 +1`);
      break;
    }
    case 'charge': {
      room.game.distance = 1; D.tempSpeed += 3; D.nextAtkBonus += 2;
      log(room, `　冲锋：距离归 1，速度 +3，下次攻击 +2`);
      break;
    }
    case 'shieldbash': {
      log(room, `　盾击：强制造成 1 点伤害`, 'k');
      dealDamage(A, 1); D.noBlock = true;
      break;
    }
    case 'feast': {
      D.hp = Math.min(15, D.hp + 5);
      log(room, `　盛宴：血量 +5（现 ${fmt(D.hp)}）`, 'y');
      break;
    }
    case 'crit': {
      D.tempSpeed += 2; log(room, `　会心：速度 +2`, 'b'); break;
    }
    case 'relay': {
      D.keepSpeed = 1; log(room, `　接力：本回合速度保留至下回合`, 'b'); break;
    }
    default: break;
  }

  if (!atk) return;
  const distAtTime = atk._dist !== undefined ? atk._dist : room.game.distance;

  if (atk.spearSure){
    log(room, `　枪出如龙，避无可避。`, 'k');
    applyHit(room, A, D, atk);
    return;
  }
  if (atk.sure){
    if (card.key === 'block'){ log(room, `　格挡成功，此击被卸。`); onBlockSuccess(room, D, A); return; }
    if (parryUsed){ log(room, `　横刀招架，刀光卸力。`); onParry(room, D, A); return; }
    log(room, `　此击必中。`);
    applyHit(room, A, D, atk);
    return;
  }
  if (distAtTime !== 1){ log(room, `　距离不合，攻势落空。`); return; }
  if (immuneByMove){ log(room, `　身法避开，此击落空。`); return; }
  if (card.key === 'block'){ log(room, `　格挡成功，此击被卸。`); onBlockSuccess(room, D, A); return; }
  if (parryUsed){ log(room, `　横刀招架，刀光卸力。`); onParry(room, D, A); return; }

  applyHit(room, A, D, atk);
}

async function runBattle(room){
  const g = room.game;
  const A = g.players[g.attackerIdx];
  const D = g.players[other(g.attackerIdx)];

  for (let i = 0; i < 5; i++){
    if (A.hp <= 0 || D.hp <= 0) break;

    const ac = A.hand[i];
    if (ac){
      A.revealed[i] = true;
      broadcastState(room);
      await sleep(280);
      const atk = await resolveAttackSide(room, A, D, ac);
      if (atk){ atk._dist = g.distance; A._lastAtk = atk; }
      broadcastState(room);
      await sleep(180);
    }

    if (A.hp <= 0 || D.hp <= 0) break;

    const dc = D.hand[i];
    if (dc){
      D.revealed[i] = true;
      broadcastState(room);
      await sleep(280);
      await resolveDefenseSide(room, D, A, dc, A._lastAtk);
      A._lastAtk = null;
      broadcastState(room);
      await sleep(180);
    }

    if (A.hp <= 0 || D.hp <= 0) break;

    if (i < 4){
      await Promise.all([
        ask(room, 0, 'next'),
        ask(room, 1, 'next')
      ]);
    }
  }
}

function endRound(room){
  const g = room.game;
  g.players.forEach(p => {
    p.tempSpeed = 0; p.keepSpeed = 0;
    if (p.nextRoundSpeed){ p.tempSpeed += p.nextRoundSpeed; p.nextRoundSpeed = 0; }
    p.noBlock = false; p.noJumpCrouch = false;
  });
  g.attackerIdx = other(g.attackerIdx);
  g.roundNo++;
  g.distance = 1;
}

async function gameLoop(room){
  const g = room.game;
  g.phase = 'battle';
  g.log = [];

  const w0 = await ask(room, 0, 'weapon');
  g.players[0] = createPlayer(0, w0);
  log(room, `${g.players[0].name} 持 ${WEAPONS[w0].name}。`);
  broadcastState(room);

  const w1 = await ask(room, 1, 'weapon');
  g.players[1] = createPlayer(1, w1);
  log(room, `${g.players[1].name} 持 ${WEAPONS[w1].name}。`);
  log(room, `江湖开局。`, 'k');

  g.attackerIdx = 0; g.roundNo = 1; g.distance = 1;

  while (true){
    g.players.forEach(p => tickCooldowns(p));
    g.distance = 1;

    const [h0, h1] = await Promise.all([
      askPick(room, 0),
      askPick(room, 1)
    ]);
    g.players[0].hand = h0;
    g.players[1].hand = h1;
    g.players.forEach(p => { p.revealed = [false,false,false,false,false]; });
    broadcastState(room);

    await runBattle(room);

    const [p0, p1] = g.players;
    if (p0.hp <= 0 && p1.hp <= 0){
      g.gameOver = {result:'draw', text:'同归于尽，此局平手。'};
      break;
    }
    if (p0.hp <= 0 || p1.hp <= 0){
      const w = p0.hp <= 0 ? p1 : p0;
      g.gameOver = {result:'win', winner:w.idx, text:`${w.name} 胜。`};
      break;
    }

    endRound(room);
    await Promise.all([
      ask(room, 0, 'next'),
      ask(room, 1, 'next')
    ]);
  }

  g.phase = 'over';
  g.waitingFor = [];
  broadcastState(room);
}

io.on('connection', socket => {
  socket.data = {};

  socket.on('createRoom', () => {
    const room = newRoom();
    room.sockets[0] = socket.id;
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.playerIdx = 0;
    room.game = {
      players: [null, null],
      log: [],
      phase: 'waiting',
      waitingFor: []
    };
    socket.emit('joined', {roomId: room.id, playerIdx: 0});
  });

  socket.on('joinRoom', ({roomId}) => {
    const room = rooms.get(roomId);
    if (!room){ socket.emit('error_msg', '房间不存在'); return; }
    if (room.sockets[1]){ socket.emit('error_msg', '房间已满'); return; }
    room.sockets[1] = socket.id;
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.playerIdx = 1;
    socket.emit('joined', {roomId: room.id, playerIdx: 1});
    gameLoop(room).catch(err => console.error(err));
  });

  socket.on('input', ({type, data}) => {
    const {roomId, playerIdx} = socket.data;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const w = room.waitings[playerIdx];
    if (!w) return;
    if (w.type !== type) return;
    delete room.waitings[playerIdx];
    w.resolve(data);
  });

  socket.on('disconnect', () => {
    const {roomId, playerIdx} = socket.data;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const otherIdx = playerIdx === 0 ? 1 : 0;
    const otherSid = room.sockets[otherIdx];
    if (otherSid) io.to(otherSid).emit('opponent_left');
    rooms.delete(roomId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`墨武服务器运行中：http://localhost:${PORT}`);
});
