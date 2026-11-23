/*
 * Dungeon Crawl: a turn-based roguelike prototype based on Matt Dinniman's "Dungeon Crawler Carl".
 * Private fan project. All art is original and drawn in code.
 *
 * HOW THE GAME IS ORGANIZED
 *   Config & data ........ names, monster families (FAM), bosses, loot tables, box tiers, achievements (ACH),
 *                          races (RACES) and classes (CLASSES). Most rules live here as data, not code.
 *   Sprites .............. every tile/monster/item is drawn once into a 32x32 offscreen canvas (SPR).
 *   State ................ one global object G holds the whole run: floor map, monsters, items, both crawlers.
 *                          G.player is Carl, G.pet is Princess Donut (a full crawler with her own stats).
 *   Floor generation ..... newFloor(): rooms + corridors, safe room, stairwells, boss lairs, monsters, items.
 *   Turn loop ............ a player action (move/attack/spell/bomb) ends with endTurn(), which runs Donut's AI
 *                          (petAct), every monster (mobsAct -> mobTurn), status ticks, the floor timer, FOV and UI.
 *   Combat ............... playerAttack, mobAttack, mobHitMob (monster vs monster), blast, fireMissile, kill().
 *   Monster AI ........... pickTarget chooses a crawler or an enemy faction mob; roles (bomber, support, janitor,
 *                          vacuum, spitter...) change behavior. Neutral mobs ignore crawlers until provoked.
 *   Rewards .............. award() grants achievements and typed/tiered loot boxes; rollBox/applyLoot open them.
 *   UI ................... ui() refreshes the side panels; draw() paints the map each animation frame (only when
 *                          something changed); drawMini() paints the minimap; modal()/selModal() show dialogs.
 *
 * CONVENTIONS
 *   Coordinates are tile units. cheb() is Chebyshev distance (diagonal moves cost 1).
 *   A "crawler" is Carl or Donut; a "mob" is any monster. Stat lookups go through st() so charms and caps apply;
 *   class/race bonuses go through fxv(c, key).
 */

// =====================================================================================================
// CONFIG & DATA
// =====================================================================================================
const NAMES = { hero: 'Carl', pet: 'Princess Donut', guide: 'Mordecai' };
const T = 32,
  WALL = 0,
  FLOOR = 1,
  SAFE = 2,
  STAIRS = 3;
const DIRS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];
const R = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = a => a[Math.floor(Math.random() * a.length)];
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const cap = s => s[0].toUpperCase() + s.slice(1);
const fmt = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : String(n));
// Element lookup. Static '#id' elements are cached because ui() touches dozens of them every turn.
const domCache = {};
const $ = s => (/^#[\w-]+$/.test(s) ? (domCache[s] ??= document.querySelector(s)) : document.querySelector(s));
// Only touch the DOM when the markup actually changed (keeps focus and avoids layout work).
const setHTML = (el, html) => {
  if (el._html !== html) {
    el._html = html;
    el.innerHTML = html;
  }
};
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (!CanvasRenderingContext2D.prototype.roundRect)
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h) {
    this.rect(x, y, w, h);
  };

// Monster families ("races"). Each family has 1-4 types; a type's `lvl` is its base level on Floor 1,
// and its ROLE changes how it fights (see mobTurn). Actual level = base + 2 per floor below the first.
const ROLES = {
  lunch: 'Boss: heavy melee, and every few turns she flings a tray of poisonous mystery meat from up to 4 tiles.',
  slam: 'Boss: crushing melee, and its spin cycle hits every crawler standing next to it.',
  melee: 'Melee brawler.',
  janitor:
    'Janitor: eats corpses and grows a level each time. The dungeon sends more when bodies pile up. Its bite can poison.',
  bomber: 'Ranged bomber: lobs bombs from up to 5 tiles. The blast hits everything nearby, its own friends included.',
  support: 'Support caster: Anguish Magic gives a nearby ally +50% damage. Keeps its distance.',
  leader: 'Clan leader: goblins near it get +1 armor.',
  hybrid: 'Hybrid: strong in melee and casts a hex from up to 4 tiles.',
  fireball: 'Ranged caster: hurls fireballs with a 3×3 blast from up to 6 tiles and keeps its distance.',
  vamp: 'Blood drinker: heals itself for half the damage it deals.',
  vacuum: 'Loot vacuum: sucks up items from the floor. Kill it to get them back.',
  spitter: 'Ranged spitter: hocks a disgusting wad from up to 3 tiles.',
};
// Factions: these families attack each other on sight (the goblin–llama turf war on Floor 1)
const FFOES = { goblin: ['llama'], llama: ['goblin'] };
// Roles that keep their distance and fall back when approached.
const KITERS = { bomber: 1, support: 1, fireball: 1 };
const FAM = {
  rat: {
    name: 'Rat-kin',
    w: 3,
    draw: 'rat',
    types: [
      {
        name: 'Rat',
        lvl: 1,
        hp: 6,
        lo: 1,
        hi: 3,
        arm: 0,
        dodge: 12,
        xp: 4,
        col: '#7b7486',
        sc: 0.8,
        role: 'janitor',
        desc: 'A screeching, gore-stuffed rat that serves as this floor’s cleanup crew. It eats the dead and gets bigger with every corpse. Out of corpses? It will settle for you.',
        tip: 'Kill rats before they reach the bodies, or you will be fighting a much larger rat later.',
      },
      {
        name: 'Rat Brute',
        lvl: 4,
        hp: 20,
        lo: 3,
        hi: 6,
        arm: 1,
        dodge: 4,
        xp: 15,
        col: '#8a5444',
        sc: 1.02,
        draw: 'ratkin',
        acc: 'brute',
        role: 'melee',
        desc: 'A five-foot rat-kin built like it skipped every day except arm day. Not much going on upstairs, which it considers a feature.',
        tip: 'Pure muscle and some armor. Let it come to you and keep your HP up.',
      },
      {
        name: 'Rat Hooligan',
        lvl: 5,
        hp: 16,
        lo: 2,
        hi: 5,
        arm: 0,
        dodge: 15,
        xp: 18,
        col: '#6d6a7a',
        sc: 1,
        draw: 'ratkin',
        acc: 'hood',
        role: 'hybrid',
        range: 4,
        cdMax: 4,
        desc: 'The rat-kin middle child: decently strong, decently magical, and fully obnoxious. Wears a hoodie indoors and throws hexes to keep you guessing.',
        tip: 'Closing the distance stops the hexes, but not the punches.',
      },
      {
        name: 'Rat Shaman',
        lvl: 7,
        hp: 14,
        lo: 4,
        hi: 7,
        arm: 0,
        dodge: 10,
        xp: 26,
        col: '#5a5068',
        sc: 1,
        draw: 'ratkin',
        acc: 'robe',
        robe: '#a83228',
        role: 'fireball',
        range: 6,
        cdMax: 4,
        desc: 'A robed rat-kin that made fire its entire personality. Stand in a clump with your friends and it will reward you with a fireball.',
        tip: 'Spread out, then rush it. It is fragile up close.',
      },
    ],
  },
  goblin: {
    name: 'Goblin',
    w: 3,
    draw: 'goblin',
    faction: 'goblin',
    types: [
      {
        name: 'Trash Goblin',
        lvl: 2,
        hp: 11,
        lo: 2,
        hi: 4,
        arm: 0,
        dodge: 5,
        xp: 8,
        col: '#7cbf4a',
        rag: '#6b4a2b',
        sc: 0.9,
        role: 'melee',
        desc: 'A small, green, deeply unwashed goblin waving a stick with a pineapple jammed on the end. It used to scavenge garbage. Now it scavenges crawlers.',
        tip: 'Kill one and the rest of the clan comes running.',
      },
      {
        name: 'Goblin Bomb Bard',
        lvl: 4,
        hp: 12,
        lo: 3,
        hi: 6,
        arm: 0,
        dodge: 8,
        xp: 16,
        col: '#76b84a',
        rag: '#5a4a3a',
        sc: 0.95,
        acc: 'spikes',
        role: 'bomber',
        range: 5,
        cdMax: 3,
        desc: 'A goblin whose spiked helmet sprays sparks, so it can light a fuse just by holding a bomb over its head. Its eyebrows have been gone for years. It does not miss them.',
        tip: 'Its bombs hit other monsters too. Fight it next to its friends.',
      },
      {
        name: 'Goblin Shamanka',
        lvl: 6,
        hp: 15,
        lo: 2,
        hi: 4,
        arm: 0,
        dodge: 10,
        xp: 22,
        col: '#6aa840',
        rag: '#4b2a6b',
        sc: 1.05,
        acc: 'robe',
        role: 'support',
        range: 5,
        cdMax: 4,
        desc: 'Second-in-command of the goblin clan and a graduate of a university whose admissions process you do not want to hear about. Practices Anguish Magic, which makes everyone else’s attacks hurt more.',
        tip: 'Priority target. Every turn it lives, something else hits harder.',
      },
      {
        name: 'Goblin War Chieftain',
        lvl: 8,
        hp: 36,
        lo: 5,
        hi: 9,
        arm: 2,
        dodge: 6,
        xp: 36,
        col: '#3f7f3a',
        rag: '#8a1f2e',
        sc: 1.15,
        crown: 1,
        role: 'leader',
        desc: 'Leader of the local clan. Wears a crown, carries a grudge, and makes every goblin near it fight harder just by glaring.',
        tip: 'Thin out its escort first, or bomb the whole group.',
      },
    ],
  },
  bat: {
    name: 'Bat',
    w: 2,
    draw: 'bat',
    erratic: 1,
    types: [
      {
        name: 'Cave Bat',
        lvl: 1,
        hp: 5,
        lo: 1,
        hi: 2,
        arm: 0,
        dodge: 25,
        xp: 3,
        col: '#6a4590',
        sc: 0.9,
        role: 'melee',
        desc: 'A leathery, shrieking nuisance that flies in no particular direction, on purpose. Its echolocation has filed you under “snack.”',
        tip: 'Hard to hit and flaps around at random. Let the cat handle it.',
      },
      {
        name: 'Vampire Bat',
        lvl: 4,
        hp: 12,
        lo: 2,
        hi: 5,
        arm: 0,
        dodge: 30,
        xp: 12,
        col: '#8a1f3a',
        sc: 1.05,
        role: 'vamp',
        desc: 'A bat that skipped fruit entirely and went straight to blood. It is very excited to meet you, specifically your neck.',
        tip: 'It heals as it bites. Burst it down fast; Magic Missile helps.',
      },
    ],
  },
  bot: {
    name: 'Robot',
    w: 1,
    draw: 'bot',
    neutral: 1,
    types: [
      {
        name: 'Feral Vacuum Bot',
        lvl: 3,
        hp: 14,
        lo: 2,
        hi: 5,
        arm: 1,
        dodge: 0,
        xp: 10,
        col: '#4a5060',
        sc: 1,
        role: 'vacuum',
        desc: 'A robot floor cleaner that gained sentience and a hoarding problem. It sucks up anything left on the floor, including the potion you were about to grab.',
        tip: 'Armored. Whatever it has vacuumed up spills out when it dies. It ignores you unless you start something.',
      },
    ],
  },
  llama: {
    name: 'Llama',
    w: 2,
    draw: 'llama',
    faction: 'llama',
    neutral: 1,
    types: [
      {
        name: 'Bad Llama',
        lvl: 3,
        hp: 14,
        lo: 2,
        hi: 5,
        arm: 0,
        dodge: 8,
        xp: 11,
        col: '#d8c7a8',
        sc: 0.95,
        role: 'spitter',
        range: 3,
        cdMax: 3,
        desc: 'A llama in a tracksuit and a gold chain, running a dubious pharmaceutical operation out of a dead-end corridor. It is locked in a turf war with the goblins. Mind your business and it will mind its own.',
        tip: 'Neutral until you start something. Let it fight the goblins for you.',
      },
      {
        name: 'Bad Llama Enforcer',
        lvl: 6,
        hp: 28,
        lo: 4,
        hi: 8,
        arm: 1,
        dodge: 6,
        xp: 22,
        col: '#8b6f4e',
        sc: 1.1,
        acc: 'shades',
        role: 'spitter',
        range: 3,
        cdMax: 3,
        desc: 'The muscle of the llama operation: bigger, meaner, and wearing sunglasses indoors. It spits with professional accuracy.',
        tip: 'Also neutral. Provoke one and its whole crew remembers your face.',
      },
    ],
  },
};
const mobLevel = (base, f) => base + (f - 1) * 2;
// Build a live monster from a type template at a given level. Extra levels above the type's base level
// add ~20% HP, +1 attack per 2 levels and +1 armor per 4. Neutral families start non-hostile.
function mkMob(tpl, lvl, pos) {
  const k = lvl - tpl.lvl;
  const hp = Math.round(tpl.hp * (1 + 0.2 * k));
  return {
    ...tpl,
    level: lvl,
    hp,
    maxhp: hp,
    lo: tpl.lo + Math.floor(k / 2),
    hi: tpl.hi + Math.floor(k / 2),
    arm: tpl.arm + Math.floor(k / 4),
    xp: Math.round(tpl.xp * (1 + 0.25 * k)),
    x: pos.x,
    y: pos.y,
    awake: false,
    hostile: !tpl.neutral,
  };
}
// which types can show up on a floor, weighted toward the weaker ones
const typeObj = (fk, i) => {
  const F = FAM[fk],
    t = F.types[i];
  return {
    ...t,
    fam: fk,
    famName: F.name,
    rank: i + 1,
    ranks: F.types.length,
    spr: fk + '_' + i,
    erratic: F.erratic,
    faction: F.faction,
    neutral: !!F.neutral,
    cd: 0,
    anguish: 0,
    eaten: 0,
    loot: [],
  };
};
// Weighted list of monster types allowed on floor f: higher-rank types unlock deeper and stay rarer.
function spawnPool(f) {
  const cap = 2 + f * 2,
    pool = [];
  for (const fk in FAM) {
    const F = FAM[fk];
    F.types.forEach((t, i) => {
      if (t.lvl > cap) return;
      const w = F.w * (10 / (1 + i * 2.5)) * (1 + 0.4 * (f - 1) * i);
      pool.push([w, typeObj(fk, i)]);
    });
  }
  return pool;
}
// Pick from a [weight, value] list.
function pickW(pool) {
  let r = Math.random() * pool.reduce((a, [w]) => a + w, 0);
  for (const [w, v] of pool) if ((r -= w) <= 0) return v;
  return pool[0][1];
}
// Bosses: one Neighborhood Boss and one (optional, much tougher) Borough Boss per floor, each in a lair.
const BOSS = {
  name: 'Madame Gristle',
  lvl: 6,
  famName: 'Neighborhood Boss',
  tier: 'Neighborhood',
  hp: 46,
  lo: 4,
  hi: 8,
  arm: 2,
  dodge: 5,
  xp: 60,
  spr: 'boss',
  boss: 1,
  role: 'lunch',
  range: 4,
  cdMax: 5,
  cd: 0,
  desc: 'The dungeon’s former lunch lady, promoted to Neighborhood Boss after her predecessor was served as the daily special. She wields a ladle with alarming confidence, flings trays of questionable meat, and has never once given anyone a second helping.',
  tip: 'Hits hard and her mystery meat is poisonous. Soften her up with bombs and Magic Missiles first.',
};
const BOROUGH = {
  name: 'The Laundromat Leviathan',
  lvl: 10,
  famName: 'Borough Boss',
  tier: 'Borough',
  hp: 80,
  lo: 6,
  hi: 11,
  arm: 3,
  dodge: 0,
  xp: 150,
  spr: 'washer',
  boss: 1,
  role: 'slam',
  cdMax: 4,
  cd: 0,
  desc: 'A coin-operated washing machine that ate its last customer and kept going. It has a porthole for a face, teeth where the lint trap should be, and a spin cycle that rattles everything standing next to it. It guards a stairwell, and it takes quarters.',
  tip: 'Optional, and built for a bigger party than yours. Its spin cycle hits everyone next to it, so don’t both crowd it.',
};
const BOROUGH_ALT = [
  [
    'The Escalator Hydra',
    'A shopping-mall escalator that grew three more heads and an appetite. It only goes down, and so will you.',
  ],
  ['Mattress King Montgomery', 'He promised the lowest prices in the borough. He did not mention the teeth.'],
  ['The Parking Garage Abbess', 'She has a ticket for you. It is validated in blood.'],
];
// Race-specific loot. weapon/armor values are +attack/+armor; charm values are stat bonuses.
// Race-keyed loot tables (the wiki: drops are keyed to race, not class). Each gear slot has six quality
// levels; index 5 only comes from Legendary/Celestial-grade rolls. `cons` lists the consumables a box can hold.
const LOOT = {
  human: {
    weapon: [
      ['Spiked Knuckle-Duster', 2],
      ['Rusty Machete', 3],
      ['Enchanted Tire Iron', 4],
      ['Bloodthirsty Frying Pan', 6],
      ['Vorpal Rebar', 8],
      ['Fist of the Final Encore', 11],
    ],
    armor: [
      ['Studded Leather Jacket', 1],
      ['Hockey Pads', 2],
      ['Riot Vest', 3],
      ['Bathrobe of Warding', 4],
      ['Mall-Cop Plate', 6],
      ['Unbothered Leather Jacket of the Apocalypse', 9],
    ],
    charm: [
      ['Lucky Bottle Cap', { crit: 4, cha: 1 }],
      ['Charm of the Iron Gut', { hp: 8 }],
      ['Ring of Quick Hands', { dex: 2 }],
      ['Brass Knuckle Charm', { str: 2, crit: 3 }],
      ['Amulet of Second Wind', { hp: 16, con: 1 }],
      ['Celestial Signet of Stubbornness', { str: 3, dex: 3, con: 3, hp: 20 }],
    ],
    cons: ['potion', 'potion', 'bomb', 'bomb', 'potion'],
  },
  cat: {
    weapon: [
      ['Sharpened Claw Caps', 2],
      ['Gilded Claw Caps', 3],
      ['Claws of Rending', 4],
      ['Obsidian Talons', 6],
      ['Claws of the Final Swat', 8],
      ['Claws of the Cosmic Swat', 11],
    ],
    armor: [
      ['Rhinestone Collar', 1],
      ['Studded Show Collar', 2],
      ['Collar of Warding', 3],
      ['Bejeweled Battle Harness', 4],
      ['Regal Mithril Collar', 6],
      ['Celestial Diamond Collar', 9],
    ],
    charm: [
      ['Catnip Charm', { int: 1 }],
      ['Pendant of the Pampered', { hp: 8 }],
      ['Glitter Charm of Focus', { mp: 4 }],
      ['Velvet Ribbon of Fury', { str: 2, int: 1 }],
      ['Starlight Bell', { int: 3, mp: 4, cha: 2 }],
      ['Tiara of Absolute Adoration', { int: 4, cha: 6, mp: 8 }],
    ],
    cons: ['kibble', 'kibble', 'kibble', 'tome'],
  },
};
const SLOTN = {
  human: { weapon: 'Weapon', armor: 'Armor', charm: 'Charm' },
  cat: { weapon: 'Claws', armor: 'Collar', charm: 'Charm' },
};
const CONSN = {
  potion: 'Healing potion',
  bomb: 'Bomb',
  kibble: 'Kibble of Mending (she eats it automatically when hurt)',
  tome: 'Tome of Arcane Sass (+1 INT, read on the spot)',
};
const STATN = {
  str: 'STR',
  dex: 'DEX',
  con: 'CON',
  int: 'INT',
  cha: 'CHA',
  hp: 'max HP',
  mp: 'max MP',
  crit: '% crit',
};
// Invented alien patrons who send Benefactor Boxes.
const SPONSORS = [
  'Glorp Synergy Holdings',
  'The Krell Luminous Collective',
  "Uncle Vexx's Discount Moons",
  'Shimmering Abyss Media',
];
const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'legendary', 'celestial'];
const TIERC = {
  bronze: '#cd7f32',
  silver: '#c3cad6',
  gold: '#f5c542',
  platinum: '#9fd8e8',
  legendary: '#ff8c1a',
  celestial: '#c77dff',
};
const TIER_ORDER = Object.fromEntries(TIERS.map((t, i) => [t, i]));
const TB = { bronze: -1, silver: 0, gold: 1, platinum: 2, legendary: 3, celestial: 4 }; // gear-quality boost per tier
const boxTier = b => b.split('|')[0],
  boxType = b => b.split('|')[1] || '',
  boxLabel = b => `${cap(boxTier(b))}${boxType(b) ? ' ' + boxType(b) : ''} Box`;
// [name, text, box tier ('none' = no box), owner, box type]. Most names and rewards follow the wiki's Floor 1 list.
const ACH = {
  crazy_cat: ['Crazy Cat Lady', 'You entered the dungeon with a cat.', 'bronze', 'hero', 'Pet'],
  trailblazer: [
    'Trailblazing Crazy Cat Lady',
    'You were the first crawler to enter the dungeon with a cat. Somebody had to be.',
    'legendary',
    'hero',
    'Pet',
  ],
  no_pants: [
    "Why Aren't You Wearing Pants?",
    'You entered the dungeon without pants. Bold. Breezy.',
    'gold',
    'hero',
    'Apparel',
  ],
  unarmed: [
    'Unarmed Combat',
    'You entered the dungeon without a weapon. Your fists are the weapon. For now.',
    'bronze',
    'hero',
    'Weapon',
  ],
  early: [
    'Early Adopter',
    'You were one of the first 5,000 crawlers through the door.',
    'silver',
    'hero',
    'Adventurer',
  ],
  sign: [
    "You've Discovered and Read an Official Dungeon Sign",
    'Your heads-up display and minimap have been upgraded: creatures, corpses and the full-floor map are now available.',
    'none',
    'hero',
  ],
  dmg_first: ["You've Inflicted Damage on a Mob", 'It hurt them more than it hurt you. Probably.', 'none', 'hero'],
  first_blood: [
    "You've Killed a Mob!",
    'Congratulations, murderer. You can now earn experience points.',
    'none',
    'hero',
  ],
  higher: [
    "You've Killed a Mob a Higher Level than Yourself!",
    'Punching up. The audience loves an underdog.',
    'bronze',
    'hero',
    'Adventurer',
  ],
  bare_hands: [
    "You've Killed an Armed Mob with Your Bare Hands!",
    'It had a weapon. You had knuckles. The knuckles won.',
    'bronze',
    'hero',
    'Weapon',
  ],
  boom: ['Boom!', 'You caused your first explosion. It will not be your last.', 'silver', 'hero', 'Goblin'],
  boom10: [
    'Demolitions Enthusiast',
    'More than 10 mobs killed with explosives. The goblins are taking notes.',
    'silver',
    'hero',
    'Goblin',
  ],
  crowd: ['Crowd Control', 'Four or more mobs killed by a single attack.', 'gold', 'hero', 'Crowd Control'],
  level2: ['Level-Up, Baby!', 'You reached level 2. The bar was low, and you cleared it.', 'none', 'hero'],
  loot_wear: ['Loot!', 'You are wearing something you found in the dungeon. Fashion is a journey.', 'none', 'hero'],
  magic_gear: ['Oooh, Magic', 'You equipped magical gear for the first time.', 'bronze', 'hero', 'Adventurer'],
  stairs: ['You Found Stairs!', 'A stairwell to the next floor. Now survive long enough to use it.', 'none', 'hero'],
  safe: [
    'Sanctuary!',
    'You found your first safe room. Nothing can hurt you in here. Except the timer.',
    'silver',
    'hero',
    'Adventurer',
  ],
  share_xp: [
    'Sharing Is Caring',
    'You shared experience with a party member for the first time.',
    'bronze',
    'hero',
    'Adventurer',
  ],
  first_spell: [
    'Abracadabra',
    'You cast a spell for the first time. The glowing was a nice touch.',
    'bronze',
    'hero',
    'Adventurer',
  ],
  pacifist: [
    'Pacifist!',
    'You survived an entire floor without hurting a single mob. The audience is deeply confused.',
    'gold',
    'hero',
    'Adventurer',
  ],
  boss_babe: [
    'Boss Babe',
    'You damaged a dungeon boss for the first time. It is by far the most common final achievement. No pressure.',
    'none',
    'hero',
  ],
  boss: [
    'Neighborhood Watch',
    'You killed a Neighborhood Boss. The neighborhood is under new management.',
    'none',
    'hero',
  ],
  borough_found: ['Borough Boss!', 'You found a Borough Boss. Finding one is the easy part.', 'none', 'hero'],
  borough: [
    'Borough Bully',
    'You killed a Borough Boss with a party of two. The showrunners are reviewing the footage.',
    'none',
    'hero',
  ],
  wall: [
    'Wall Inspector',
    'You have walked into a wall five times. The walls are fine, thanks for asking.',
    'bronze',
    'hero',
    'Adventurer',
  ],
  open_box: [
    'Unboxing Video',
    'You opened a box. Several trillion viewers watched you do it.',
    'bronze',
    'hero',
    'Adventurer',
  ],
  nbmap: [
    'Where the Hell Am I?',
    'You looted a Neighborhood Map. One square mile of this hellscape is now slightly less confusing.',
    'none',
    'hero',
  ],
  clutch: [
    'Living Dangerously',
    'A kill while nearly dead. Your heart rate was a ratings spike.',
    'silver',
    'hero',
    'Survivor’s',
  ],
  lvl3: [
    'Look at You, Growing Up',
    'Level 3. Statistically you are now slightly less doomed.',
    'silver',
    'hero',
    'Adventurer',
  ],
  ten: ['Exterminator', 'Ten kills. The local wildlife has filed a complaint.', 'silver', 'hero', 'Weapon'],
  descend: [
    'Stair Master',
    'You survived a floor. Most did not. Try not to let it go to your head.',
    'silver',
    'hero',
    'Adventurer',
  ],
  close: [
    'Cutting It Close',
    'You took the stairs with under 60 turns to spare. Was that on purpose? Be honest.',
    'gold',
    'hero',
    'Adventurer',
  ],
  impatient: [
    'Impatient Drinker',
    'You drank a potion before your cooldown was up. Your liver has filed a formal complaint.',
    'bronze',
    'hero',
    'Survivor’s',
  ],
  friendly_fire: [
    'Friendly Fire!',
    'A monster killed its own teammate. You get credit for standing in the general vicinity.',
    'bronze',
    'hero',
    'Adventurer',
  ],
  turf_war: [
    'Turf War',
    'Two factions killed each other while you watched. You did nothing and got paid for it.',
    'bronze',
    'hero',
    'Adventurer',
  ],
  charm_hero: [
    'Smooth Operator',
    'You charmed a mob yourself. Somewhere, a cat is furious.',
    'bronze',
    'hero',
    'Apparel',
  ],
  priority: [
    'Shut Up, Shamanka',
    'You killed a support caster. Everyone else just lost their hype man.',
    'silver',
    'hero',
    'Weapon',
  ],
  fat_rat: [
    'Cleanup on Aisle You',
    'You killed a janitor rat that had eaten three or more corpses. Gross, but well done.',
    'silver',
    'hero',
    'Adventurer',
  ],
  mm3: [
    'Magic Missile Prodigy',
    'Magic Missile reached level 3. Not many crawlers get there this fast.',
    'gold',
    'pet',
    'Magic Item',
  ],
  beguiler: [
    'Beguiler',
    'You charmed multiple dungeon mobs. Charisma is a weapon, and you are armed.',
    'gold',
    'pet',
    'Beguiler',
  ],
  second_chance: [
    'Second Chance',
    'You raised a dead mob to fight for you. Necromancy is so in this season.',
    'bronze',
    'pet',
    'Magic Item',
  ],
  pet_kill: [
    'Murder Mittens',
    'Your first kill! Adorable. Horrifying. Mostly adorable. You can now earn experience points.',
    'bronze',
    'pet',
    'Adventurer',
  ],
  pet_crit: ['Precision Swat', 'A critical scratch. Somewhere, a vet just felt a chill.', 'bronze', 'pet', 'Weapon'],
  pet_missile: [
    'Arcane Menace',
    'A kill with Magic Missile. The fan mail is already pouring in.',
    'bronze',
    'pet',
    'Magic Item',
  ],
  pet_snack: ['Emotional Eater', 'You ate kibble in the middle of a fight. Relatable.', 'bronze', 'pet', 'Survivor’s'],
  pet_clutch: [
    'Nine Lives, Minus a Few',
    'A kill while badly hurt. The crowd gasped. Then cheered.',
    'silver',
    'pet',
    'Survivor’s',
  ],
  pet_lvl3: [
    'Glow-Up',
    'Level 3. You were already perfect, but now there are numbers to prove it.',
    'silver',
    'pet',
    'Apparel',
  ],
  pet_ten: ['Apex Predator', 'Ten kills. The food chain has been updated.', 'silver', 'pet', 'Weapon'],
  pet_boss: ['Boss Battle Diva', 'You landed the killing blow on a boss. Naturally.', 'silver', 'pet', 'Adventurer'],
};
// =====================================================================================================
// RACES AND CLASSES (CHOSEN ON THE THIRD FLOOR)
// =====================================================================================================
const RACES = {
  human: {
    name: 'Human',
    mods: {},
    fx: {},
    desc: 'Stay as you are. Middle of the road at everything, which is to say, at nothing.',
  },
  primal: {
    name: 'Primal',
    mods: { str: 2, con: 2, cha: -1 },
    fx: { spellCap: 20 },
    desc: 'A rare Earth race the AI is cagey about. Stronger and tougher than a human, and spells can be trained past level 15, all the way to 20.',
  },
  hobgoblin: {
    name: 'Hobgoblin',
    mods: { str: 3, con: 1, cha: -2 },
    fx: { bombMul: 0.5, chaCap: 8 },
    req: () => G.ach.has('boom') && G.player.bombKills >= 5,
    reqTxt: 'Requires the Boom! achievement and 5 explosive kills',
    desc: 'Big, muscular goblinoids with festering sores, specialists in traps and explosives. Bombs deal +50% damage, but Charisma is capped at 8.',
  },
  ratkin: {
    name: 'Rat-kin',
    mods: { dex: 3, int: 1, cha: -1 },
    fx: { poisonHit: 0.25 },
    desc: 'Bipedal, five-foot rat folk. Quick and a little magical, and your melee hits can poison.',
  },
};
const CAT_RACE = { name: 'Cat', mods: { str: -3, dex: 4, con: 2, cha: 1 } };
const CLASSES = {
  fighter: {
    who: 'hero',
    name: 'Fighter',
    type: 'Base',
    min: { str: 6 },
    fx: { melee: 2, armor: 1 },
    desc: 'Straightforward melee: +2 melee damage and +1 armor.',
  },
  monk: {
    who: 'hero',
    name: 'Monk',
    type: 'Base',
    min: { dex: 7, con: 6 },
    fx: { unarmed: 3, unarmedCrit: 5, dodge: 8 },
    desc: 'Disciplined unarmed fighter. +3 damage and +5% crit while bare-fisted, and monsters hit you 8% less often.',
  },
  barbarian: {
    who: 'hero',
    name: 'Barbarian',
    type: 'Base',
    min: { str: 8, con: 7 },
    fx: { rage: 0.5 },
    desc: 'Rage incarnate: +50% melee damage while below 40% HP.',
  },
  rogue: {
    who: 'hero',
    name: 'Rogue',
    type: 'Base',
    min: { dex: 8 },
    fx: { crit: 6, critMul: 3 },
    desc: '+6% crit chance, and crits deal triple damage.',
  },
  mage: {
    who: 'hero',
    name: 'Mage',
    type: 'Base',
    min: { int: 6 },
    fx: { mp: 4 },
    learn: 'missile',
    desc: 'Learn Magic Missile (key F) and gain +4 max MP.',
  },
  cleric: {
    who: 'hero',
    name: 'Cleric',
    type: 'Base',
    min: { int: 5, cha: 6 },
    fx: { healMul: 0.5, healParty: 1 },
    desc: 'Heal is 50% stronger and heals Princess Donut too.',
  },
  bombtech: {
    who: 'hero',
    name: 'Bomb Squad Tech',
    type: 'Earth',
    min: { dex: 6 },
    fx: { bombMul: 0.5, bombImmune: 1 },
    req: () => G.ach.has('boom'),
    reqTxt: 'Requires the Boom! achievement',
    onPick: c => {
      c.inv.bomb += 3;
    },
    desc: 'Bombs deal +50% damage and never hurt you. Comes with 3 bombs.',
  },
  anarchist: {
    who: 'hero',
    name: 'Compensated Anarchist',
    type: 'Monk, Rogue, Earth',
    min: { cha: 10, dex: 6 },
    fx: { unarmed: 3, bombMul: 0.5, bombImmune: 1, views: 0.5 },
    req: () => G.ach.has('boom') && G.player.bombKills >= 10 && G.views >= 100000,
    reqTxt: 'Requires Boom!, 10 explosive kills and 100K views',
    desc: 'Carl’s class in the books. +3 unarmed damage, bombs +50% that never hurt you, and the audience can’t look away: +50% views.',
  },
  bard: {
    who: 'pet',
    name: 'Bard',
    type: 'Base',
    min: { cha: 15 },
    fx: { charm: 15, views: 0.2 },
    desc: 'Suggested by Mordecai for anyone this charismatic. +15% charm chance and +20% views.',
  },
  petmage: {
    who: 'pet',
    name: 'Mage',
    type: 'Base',
    min: { int: 8 },
    fx: { missile: 3, missileCost: 1 },
    desc: 'Magic Missile deals +3 damage and costs 1 less mana.',
  },
  berserker: {
    who: 'pet',
    name: 'Feral Cat Berserker',
    type: 'Earth',
    min: { str: 3, dex: 10 },
    fx: { scratch: 3, crit: 8 },
    desc: 'A barbarian-type class. Scratches deal +3 damage, with +8% crit.',
  },
  necrobard: {
    who: 'pet',
    name: 'NecroBard',
    type: 'Bard, Necromancer',
    min: { cha: 15, int: 9 },
    fx: { charm: 10, necroTax: 1 },
    learn: 'second',
    desc: 'Learns Second Chance: raises a freshly killed mob as an undead minion that fights for you for 10+ turns (8 MP). +10% charm, but other spells cost 10% more mana.',
  },
  childactor: {
    who: 'pet',
    name: 'Former Child Actor',
    type: 'Bard, Rogue, Earth',
    min: { cha: 20 },
    fx: { views: 0.5, charm: 10, crit: 5 },
    req: () => G.views >= 50000,
    reqTxt: 'Requires 50K views',
    desc: 'Donut’s rare class in the books. +50% views, +10% charm and +5% crit.',
  },
};
// class + race effect lookup
function fxv(c, k) {
  return ((c.cls && CLASSES[c.cls].fx[k]) || 0) + ((c.raceKey && RACES[c.raceKey].fx[k]) || 0);
}
// Donut's lines, by occasion.
const PETL = {
  kill: [
    'Did everyone see that? Somebody tell me the cameras got that.',
    'That one was for my fans.',
    'I am a delight AND a menace.',
  ],
  low: [`${NAMES.hero}! You are leaking! Drink something!`, 'If you die, I am NOT carrying you.'],
  box: ['Ooh, is any of it for me? It should be for me.', 'Shiny. I approve.'],
  lvl: ['Finally. I was getting embarrassed for you.', 'Congratulations, I suppose.'],
  missile: ['Magic Missile!', 'Pew. Pew pew.'],
  hurt: ['How DARE you.', 'My fur! Do you know how long this takes?'],
};

// =====================================================================================================
// SPRITES (ORIGINAL ART, DRAWN IN CODE)
// =====================================================================================================
function mk(fn) {
  const c = document.createElement('canvas');
  c.width = c.height = T;
  fn(c.getContext('2d'));
  return c;
}
// Soft ground shadow under a sprite.
function sh(x, w = 11) {
  x.fillStyle = 'rgba(0,0,0,.35)';
  x.beginPath();
  x.ellipse(16, 27, w, 3.5, 0, 0, 7);
  x.fill();
}
const SPR = {};
SPR.floor = [0, 1, 2].map(v =>
  mk(x => {
    x.fillStyle = '#2c2438';
    x.fillRect(0, 0, T, T);
    x.fillStyle = '#3a3049';
    for (const [a, b] of [
      [1, 1],
      [17, 1],
      [1, 17],
      [17, 17],
    ])
      x.fillRect(a, b, 14, 14);
    x.fillStyle = 'rgba(255,255,255,.05)';
    x.fillRect(1, 1, 14, 2);
    x.fillRect(17, 17, 14, 2);
    if (v == 1) {
      x.strokeStyle = '#272033';
      x.beginPath();
      x.moveTo(5, 20);
      x.lineTo(10, 26);
      x.lineTo(13, 24);
      x.stroke();
    }
    if (v == 2) {
      x.fillStyle = '#2a2234';
      x.fillRect(21, 6, 3, 3);
      x.fillRect(6, 22, 2, 2);
    }
  }),
);
SPR.wall = mk(x => {
  x.fillStyle = '#4b3e5e';
  x.fillRect(0, 0, T, T);
  x.fillStyle = '#625279';
  x.fillRect(0, 0, T, 10);
  x.fillStyle = '#2e2540';
  for (let r = 0; r < 3; r++) {
    x.fillRect(0, 10 + r * 8, T, 1);
    for (let c = r % 2 ? 8 : 0; c < T; c += 16) x.fillRect(c, 10 + r * 8, 1, 8);
  }
  x.fillStyle = 'rgba(255,255,255,.1)';
  x.fillRect(0, 0, T, 2);
});
SPR.safe = mk(x => {
  x.fillStyle = '#4a3527';
  x.fillRect(0, 0, T, T);
  x.fillStyle = '#5d4431';
  x.fillRect(2, 2, 28, 28);
  x.strokeStyle = 'rgba(245,197,66,.3)';
  x.strokeRect(5.5, 5.5, 21, 21);
});
SPR.stairs = mk(x => {
  x.fillStyle = '#2c2438';
  x.fillRect(0, 0, T, T);
  for (let i = 0; i < 4; i++) {
    x.fillStyle = `hsl(178,70%,${66 - i * 13}%)`;
    x.fillRect(4 + i * 2, 4 + i * 6, 24 - i * 4, 5);
  }
  x.fillStyle = '#071413';
  x.fillRect(12, 28, 8, 3);
});
SPR.hero = mk(x => {
  sh(x, 9);
  x.fillStyle = '#2a2f45';
  x.fillRect(11, 20, 4, 7);
  x.fillRect(17, 20, 4, 7);
  x.fillStyle = '#3d7be0';
  x.beginPath();
  x.roundRect(9, 11, 14, 11, 3);
  x.fill();
  x.fillStyle = '#9fc2ff';
  x.fillRect(9, 11, 14, 2);
  x.fillStyle = '#e9b98f';
  x.beginPath();
  x.arc(16, 8, 5, 0, 7);
  x.fill();
  x.fillStyle = '#5a3a22';
  x.beginPath();
  x.arc(16, 6.5, 5, Math.PI, 0);
  x.fill();
});
SPR.pet = mk(x => {
  sh(x, 8);
  x.fillStyle = '#ff7ab6';
  x.beginPath();
  x.arc(16, 15, 10, 0, 7);
  x.fill();
  x.strokeStyle = '#fff';
  x.lineWidth = 2;
  x.stroke();
  x.fillStyle = '#fff';
  x.beginPath();
  x.ellipse(16, 18.5, 4, 3.2, 0, 0, 7);
  x.fill();
  for (const [a, b] of [
    [10.5, 13.5],
    [14.2, 10.5],
    [17.8, 10.5],
    [21.5, 13.5],
  ]) {
    x.beginPath();
    x.arc(a, b, 1.8, 0, 7);
    x.fill();
  }
});
const DRAW = {
  rat: (x, t) => {
    x.strokeStyle = '#d98aa0';
    x.lineWidth = 2;
    x.beginPath();
    x.moveTo(7, 22);
    x.quadraticCurveTo(1, 20, 3, 13);
    x.stroke();
    x.fillStyle = t.col;
    x.beginPath();
    x.ellipse(15, 20, 9, 6, 0, 0, 7);
    x.fill();
    x.beginPath();
    x.ellipse(24, 18, 5, 4, 0, 0, 7);
    x.fill();
    x.fillStyle = '#c4a9bd';
    x.beginPath();
    x.arc(22, 13.5, 2.5, 0, 7);
    x.fill();
    x.fillStyle = '#ff3344';
    x.fillRect(25, 16, 2, 2);
    if (t.crown) crown(x, 22, 9);
  },
  goblin: (x, t) => {
    x.fillStyle = t.rag;
    x.beginPath();
    x.roundRect(10, 15, 12, 11, 3);
    x.fill();
    x.fillStyle = t.col;
    x.beginPath();
    x.moveTo(4, 7);
    x.lineTo(12, 11);
    x.lineTo(11, 15);
    x.fill();
    x.beginPath();
    x.moveTo(28, 7);
    x.lineTo(20, 11);
    x.lineTo(21, 15);
    x.fill();
    x.beginPath();
    x.arc(16, 11, 6, 0, 7);
    x.fill();
    x.fillStyle = '#ffd23f';
    x.fillRect(13, 10, 2, 2);
    x.fillRect(18, 10, 2, 2);
    x.fillStyle = '#2b1a10';
    x.fillRect(13, 14, 6, 1);
    if (t.crown) crown(x, 16, 4);
    if (t.acc == 'spikes') {
      x.fillStyle = '#55585f';
      x.beginPath();
      x.arc(16, 8, 6.2, Math.PI, 0);
      x.fill();
      x.fillStyle = '#a7aab3';
      for (const sx of [11, 14, 18, 21]) {
        x.beginPath();
        x.moveTo(sx - 1.2, 6);
        x.lineTo(sx, 1);
        x.lineTo(sx + 1.2, 6);
        x.fill();
      }
      x.fillStyle = '#ffd23f';
      x.fillRect(9, 1, 2, 2);
      x.fillRect(22, 2, 2, 2);
      x.fillStyle = '#1d1b22';
      x.beginPath();
      x.arc(24, 20, 3.5, 0, 7);
      x.fill();
    }
    if (t.acc == 'robe') {
      x.fillStyle = t.rag;
      x.beginPath();
      x.moveTo(8, 27);
      x.lineTo(24, 27);
      x.lineTo(21, 15);
      x.lineTo(11, 15);
      x.fill();
      x.strokeStyle = '#8a6a3a';
      x.lineWidth = 1.5;
      x.beginPath();
      x.moveTo(26, 27);
      x.lineTo(26, 8);
      x.stroke();
      x.fillStyle = '#c77dff';
      x.beginPath();
      x.arc(26, 7, 2.6, 0, 7);
      x.fill();
    }
  },
  bat: (x, t) => {
    x.fillStyle = t.col;
    x.beginPath();
    x.moveTo(16, 13);
    x.lineTo(3, 8);
    x.lineTo(7, 15);
    x.lineTo(4, 19);
    x.lineTo(16, 17);
    x.lineTo(28, 19);
    x.lineTo(25, 15);
    x.lineTo(29, 8);
    x.fill();
    x.fillStyle = '#2b1838';
    x.beginPath();
    x.ellipse(16, 15, 4, 5, 0, 0, 7);
    x.fill();
    x.fillStyle = '#ffe066';
    x.fillRect(14, 13, 1.5, 1.5);
    x.fillRect(17, 13, 1.5, 1.5);
  },
  ratkin: (x, t) => {
    x.strokeStyle = '#d98aa0';
    x.lineWidth = 2;
    x.beginPath();
    x.moveTo(11, 24);
    x.quadraticCurveTo(4, 26, 4, 18);
    x.stroke();
    x.fillStyle = '#3a3040';
    x.fillRect(12, 22, 3, 5);
    x.fillRect(17, 22, 3, 5);
    const body = t.acc == 'robe' ? t.robe : t.acc == 'hood' ? '#33475e' : t.col;
    x.fillStyle = body;
    if (t.acc == 'robe') {
      x.beginPath();
      x.moveTo(9, 27);
      x.lineTo(23, 27);
      x.lineTo(20, 12);
      x.lineTo(12, 12);
      x.fill();
    } else {
      x.beginPath();
      x.roundRect(t.acc == 'brute' ? 8 : 10, 12, t.acc == 'brute' ? 16 : 12, 11, 3);
      x.fill();
    }
    if (t.acc == 'brute') {
      x.fillStyle = '#c9ccd6';
      [
        [8, 12],
        [23, 12],
      ].forEach(([a, b]) => {
        x.beginPath();
        x.moveTo(a, b + 3);
        x.lineTo(a + 1, b - 3);
        x.lineTo(a + 3, b + 2);
        x.fill();
      });
    }
    x.fillStyle = t.col;
    x.beginPath();
    x.ellipse(16, 8, 5, 5, 0, 0, 7);
    x.fill();
    x.beginPath();
    x.moveTo(19, 7);
    x.lineTo(26, 10);
    x.lineTo(19, 11);
    x.fill();
    x.fillStyle = '#c4a9bd';
    x.beginPath();
    x.arc(13, 3.5, 2.2, 0, 7);
    x.fill();
    x.beginPath();
    x.arc(18, 3.5, 2.2, 0, 7);
    x.fill();
    if (t.acc == 'hood') {
      x.fillStyle = '#33475e';
      x.beginPath();
      x.arc(16, 7, 6, Math.PI * 1.05, Math.PI * 1.95);
      x.fill();
    }
    x.fillStyle = '#ff3344';
    x.fillRect(18, 7, 2, 2);
    if (t.acc == 'robe') {
      x.strokeStyle = '#8a6a3a';
      x.lineWidth = 1.5;
      x.beginPath();
      x.moveTo(26, 26);
      x.lineTo(26, 9);
      x.stroke();
      x.fillStyle = '#ff8c2a';
      x.beginPath();
      x.arc(26, 8, 2.6, 0, 7);
      x.fill();
      x.fillStyle = '#ffe066';
      x.beginPath();
      x.arc(26, 8, 1.2, 0, 7);
      x.fill();
    }
  },
  llama: (x, t) => {
    x.fillStyle = t.col;
    x.beginPath();
    x.ellipse(13, 19, 8, 5, 0, 0, 7);
    x.fill();
    for (const lx of [7, 11, 15, 18]) x.fillRect(lx, 21, 2.5, 6);
    x.beginPath();
    x.roundRect(18, 6, 5, 14, 2);
    x.fill();
    x.beginPath();
    x.ellipse(23, 7, 5, 3.4, 0, 0, 7);
    x.fill();
    x.beginPath();
    x.moveTo(19, 4.5);
    x.lineTo(20, 0);
    x.lineTo(21.5, 4.5);
    x.fill();
    x.beginPath();
    x.moveTo(22, 4.5);
    x.lineTo(23.5, 0);
    x.lineTo(24.5, 4.5);
    x.fill();
    x.fillStyle = '#2b2f45';
    x.fillRect(6, 16, 14, 3);
    x.fillStyle = '#e8e8f0';
    x.fillRect(6, 17, 14, 0.8);
    x.strokeStyle = '#f5c542';
    x.lineWidth = 1.3;
    x.beginPath();
    x.arc(20.5, 12, 2.6, 0, Math.PI);
    x.stroke();
    x.fillStyle = '#1d1b22';
    if (t.acc == 'shades') x.fillRect(22, 5.5, 5.5, 2.2);
    else x.fillRect(24, 6, 1.6, 1.6);
  },
  bot: (x, t) => {
    x.fillStyle = '#2b2f38';
    x.beginPath();
    x.ellipse(16, 19, 12, 7, 0, 0, 7);
    x.fill();
    x.fillStyle = t.col;
    x.beginPath();
    x.ellipse(16, 17, 10, 5.5, 0, 0, 7);
    x.fill();
    x.fillStyle = '#ff2a4a';
    x.beginPath();
    x.arc(16, 16, 2, 0, 7);
    x.fill();
    x.fillStyle = '#c9ccd6';
    for (let i = 0; i < 5; i++) x.fillRect(8 + i * 4, 24, 2, 3);
  },
};
// Small gold crown drawn on top-rank monsters.
function crown(x, cx, cy) {
  x.fillStyle = '#f5c542';
  x.beginPath();
  x.moveTo(cx - 5, cy + 3);
  x.lineTo(cx - 5, cy - 2);
  x.lineTo(cx - 2.5, cy + 1);
  x.lineTo(cx, cy - 3);
  x.lineTo(cx + 2.5, cy + 1);
  x.lineTo(cx + 5, cy - 2);
  x.lineTo(cx + 5, cy + 3);
  x.fill();
}
for (const fk in FAM)
  FAM[fk].types.forEach(
    (t, i) =>
      (SPR[fk + '_' + i] = mk(x => {
        sh(x, 8 + 3 * t.sc);
        x.save();
        x.translate(16, 27);
        x.scale(t.sc, t.sc);
        x.translate(-16, -27);
        DRAW[t.draw || FAM[fk].draw](x, t);
        x.restore();
      })),
  );
SPR.corpse = mk(x => {
  x.fillStyle = 'rgba(110,16,28,.75)';
  x.beginPath();
  x.ellipse(16, 22, 11, 5, 0, 0, 7);
  x.fill();
  x.fillStyle = 'rgba(150,30,40,.6)';
  x.beginPath();
  x.ellipse(12, 20, 5, 3, 0.4, 0, 7);
  x.fill();
  x.fillStyle = '#d9d0c0';
  x.fillRect(14, 19, 9, 2);
  x.fillRect(13, 18, 2, 4);
  x.fillRect(22, 18, 2, 4);
});
SPR.boss = mk(x => {
  sh(x, 13);
  x.fillStyle = '#7a2b3a';
  x.beginPath();
  x.roundRect(6, 12, 20, 16, 5);
  x.fill();
  x.fillStyle = '#f1ece4';
  x.beginPath();
  x.roundRect(10, 14, 12, 13, 2);
  x.fill();
  x.fillStyle = '#e0a07a';
  x.beginPath();
  x.arc(16, 8, 6, 0, 7);
  x.fill();
  x.fillStyle = 'rgba(255,255,255,.75)';
  x.beginPath();
  x.arc(16, 5.5, 6, Math.PI, 0);
  x.fill();
  x.fillStyle = '#2a1a1a';
  x.fillRect(13, 8, 2, 2);
  x.fillRect(17, 8, 2, 2);
  x.strokeStyle = '#b8bcc6';
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(28, 5);
  x.lineTo(28, 19);
  x.stroke();
  x.fillStyle = '#b8bcc6';
  x.beginPath();
  x.arc(28, 20, 3.2, 0, Math.PI);
  x.fill();
});
SPR.washer = mk(x => {
  sh(x, 13);
  x.fillStyle = '#e8e6ee';
  x.beginPath();
  x.roundRect(4, 3, 24, 25, 3);
  x.fill();
  x.fillStyle = '#b9b6c6';
  x.fillRect(4, 3, 24, 5);
  x.fillStyle = '#ff3d7f';
  x.fillRect(7, 4.5, 3, 2);
  x.fillStyle = '#5fe0d0';
  x.fillRect(12, 4.5, 2, 2);
  x.fillStyle = '#2c2a3a';
  x.beginPath();
  x.arc(16, 17, 8.5, 0, 7);
  x.fill();
  x.fillStyle = '#4f7fb8';
  x.beginPath();
  x.arc(16, 17, 6.5, 0, 7);
  x.fill();
  x.fillStyle = '#fff';
  x.beginPath();
  x.ellipse(16, 15.5, 3.2, 2.6, 0, 0, 7);
  x.fill();
  x.fillStyle = '#d1242f';
  x.beginPath();
  x.arc(16.5, 15.5, 1.5, 0, 7);
  x.fill();
  x.fillStyle = '#f4f0e0';
  for (let i = 0; i < 5; i++) {
    x.beginPath();
    x.moveTo(10.5 + i * 2.4, 22);
    x.lineTo(11.7 + i * 2.4, 19);
    x.lineTo(12.9 + i * 2.4, 22);
    x.fill();
  }
});
SPR.sign = mk(x => {
  sh(x, 8);
  x.fillStyle = '#6b4a2b';
  x.fillRect(15, 14, 2.5, 13);
  x.fillStyle = '#e8d8b0';
  x.beginPath();
  x.roundRect(5, 5, 22, 12, 2);
  x.fill();
  x.strokeStyle = '#8a6a3a';
  x.lineWidth = 1.5;
  x.strokeRect(6.5, 6.5, 19, 9);
  x.fillStyle = '#ff3d7f';
  x.fillRect(9, 9, 14, 1.6);
  x.fillStyle = '#5a4a3a';
  x.fillRect(9, 12, 10, 1.2);
});
SPR.map = mk(x => {
  sh(x, 9);
  x.fillStyle = '#e8d8b0';
  x.beginPath();
  x.moveTo(6, 10);
  x.lineTo(12, 8);
  x.lineTo(20, 10);
  x.lineTo(26, 8);
  x.lineTo(26, 22);
  x.lineTo(20, 24);
  x.lineTo(12, 22);
  x.lineTo(6, 24);
  x.fill();
  x.strokeStyle = '#b5972f';
  x.beginPath();
  x.moveTo(12, 8);
  x.lineTo(12, 22);
  x.moveTo(20, 10);
  x.lineTo(20, 24);
  x.stroke();
  x.strokeStyle = '#d1242f';
  x.lineWidth = 1.5;
  x.beginPath();
  x.moveTo(8, 20);
  x.lineTo(14, 14);
  x.lineTo(18, 18);
  x.lineTo(23, 12);
  x.stroke();
});
SPR.guide = mk(x => {
  sh(x, 9);
  x.fillStyle = '#2e6b5e';
  x.beginPath();
  x.roundRect(8, 7, 16, 19, 2);
  x.fill();
  x.fillStyle = '#c3cad6';
  x.fillRect(10, 9, 12, 3);
  x.fillStyle = '#f5c542';
  x.beginPath();
  x.arc(16, 18, 3.5, 0, 7);
  x.fill();
  x.fillStyle = '#2e6b5e';
  x.beginPath();
  x.arc(16, 18, 1.5, 0, 7);
  x.fill();
});
SPR.potion = mk(x => {
  sh(x, 6);
  x.fillStyle = '#d9d2e6';
  x.fillRect(14, 7, 4, 6);
  x.fillStyle = '#8a5a3a';
  x.fillRect(14, 5, 4, 3);
  x.fillStyle = '#ff4d6d';
  x.beginPath();
  x.arc(16, 19, 7, 0, 7);
  x.fill();
  x.fillStyle = 'rgba(255,255,255,.5)';
  x.beginPath();
  x.arc(13.5, 17, 2, 0, 7);
  x.fill();
});
SPR.bomb = mk(x => {
  sh(x, 7);
  x.fillStyle = '#1d1b22';
  x.beginPath();
  x.arc(15, 19, 7.5, 0, 7);
  x.fill();
  x.fillStyle = 'rgba(255,255,255,.25)';
  x.beginPath();
  x.arc(12, 16, 2, 0, 7);
  x.fill();
  x.strokeStyle = '#c9a06a';
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(19, 12);
  x.quadraticCurveTo(22, 7, 25, 8);
  x.stroke();
  x.fillStyle = '#ffd23f';
  x.beginPath();
  x.arc(25.5, 7.5, 2.5, 0, 7);
  x.fill();
});
for (const k in TIERC)
  SPR['box_' + k] = mk(x => {
    sh(x, 10);
    x.fillStyle = TIERC[k];
    x.fillRect(7, 11, 18, 15);
    x.fillStyle = 'rgba(0,0,0,.25)';
    x.fillRect(7, 11, 18, 4);
    x.fillStyle = 'rgba(255,255,255,.85)';
    x.fillRect(15, 11, 2, 15);
    x.fillStyle = 'rgba(255,255,255,.35)';
    x.fillRect(7, 11, 18, 1);
  });

// =====================================================================================================
// STATE
// =====================================================================================================
let G = null;
const idx = (x, y) => y * G.W + x;
const tile = (x, y) => (x < 0 || y < 0 || x >= G.W || y >= G.H ? WALL : G.map[idx(x, y)]);
const mobAt = (x, y) => G.mobs.find(m => m.x == x && m.y == y);
const itemAt = (x, y) => G.items.find(i => i.x == x && i.y == y);
const followers = () => Math.floor(G.views / 30);
// Is tile (x,y) taken by a crawler or a mob (other than `self`)? A knocked-out Donut doesn't block.
function occupied(x, y, self) {
  const p = G.player,
    pt = G.pet;
  if (p !== self && p.x == x && p.y == y) return true;
  if (pt !== self && !pt.down && pt.x == x && pt.y == y) return true;
  const m = mobAt(x, y);
  return m && m !== self;
}

// Start a fresh run: both crawlers at level 1 with the book's starting stats, then Floor 1.
function newGame() {
  const g = (n, v) => ({ n, v, t: -1 });
  G = {
    floor: 0,
    views: 0,
    ach: new Set(),
    kills: 0,
    bumps: 0,
    log: [],
    nextSponsor: 60,
    petTalk: 0,
    fx: [],
    camX: null,
    camY: null,
    shake: 0,
    over: false,
    hud: false,
    chosen: false,
    player: {
      who: 'hero',
      race: 'human',
      name: NAMES.hero,
      x: 0,
      y: 0,
      lvl: 1,
      xp: 0,
      next: 20,
      str: 6,
      int: 3,
      con: 5,
      dex: 5,
      cha: 4,
      pts: 0,
      bank: 0,
      hp: 1,
      maxhp: 1,
      mp: 0,
      maxmp: 0,
      mpT: 0,
      potCD: 0,
      poison: 0,
      kills: 0,
      bombKills: 0,
      charms: 0,
      xpOn: false,
      boxes: [],
      spells: { heal: { lvl: 1, xp: 0 } },
      gear: { weapon: g('Bare Fists', 0), armor: g('Torn T-shirt', 0), charm: null },
      inv: { potion: 2, bomb: 1 },
    },
    pet: {
      who: 'pet',
      race: 'cat',
      name: NAMES.pet,
      x: 0,
      y: 0,
      lvl: 1,
      xp: 0,
      next: 20,
      str: 6,
      int: 7,
      con: 2,
      dex: 8,
      cha: 15,
      pts: 0,
      hp: 1,
      maxhp: 1,
      mp: 0,
      maxmp: 0,
      mpT: 0,
      potCD: 0,
      poison: 0,
      charms: 0,
      kills: 0,
      xpOn: false,
      boxes: [],
      down: false,
      spells: { missile: { lvl: 1, xp: 0 } },
      gear: { weapon: g('Natural Claws', 0), armor: g('Bare Fur', 0), charm: null },
      inv: { kibble: 1, tome: 0 },
    },
  };
  for (const c of [G.player, G.pet]) {
    recalc(c);
    c.hp = c.maxhp;
    c.mp = c.maxmp;
  }
  newFloor(1);
  // the wiki's achievements for entering the dungeon (Carl walked in with a cat, no pants and no weapon)
  for (const a of ['crazy_cat', 'trailblazer', 'no_pants', 'unarmed', 'early']) award(a, true);
  toast('Achievements for entering the dungeon', '5 new achievements');
  ai('Find a safe room to open your boxes. And look for an official dungeon sign: reading one upgrades your minimap.');
}
const cb = (c, k) => (c.gear.charm && c.gear.charm.v[k]) || 0; // charm bonus
const st = (c, k) => {
  const v = (c[k] || 0) + cb(c, k);
  if (k == 'cha') {
    const cap = fxv(c, 'chaCap');
    if (cap) return Math.min(v, cap);
  }
  return v;
}; // effective stat
// Wiki rules: CON sets the health pool and the potion cooldown; INT sets the mana pool (MP ≈ INT) and how fast it refills.
function recalc(c) {
  c.maxhp = 10 + st(c, 'con') * 4 + c.lvl * 4 + cb(c, 'hp');
  c.hp = Math.min(c.hp, c.maxhp);
  c.maxmp = st(c, 'int') + cb(c, 'mp') + fxv(c, 'mp');
  c.mp = Math.min(c.mp, c.maxmp);
}
const mpEvery = c => Math.max(1, Math.round(36 / Math.pow(Math.max(1, st(c, 'int')), 1.2))); // turns per 1 MP regained
const potionCD = c => Math.max(3, 20 - st(c, 'con') * 2); // turns between potions
// Spells level up through use; combat casts train faster than practice. Big jumps at levels 5 and 10.
const SPELLS = {
  heal: { name: 'Heal', cost: () => 3 },
  missile: { name: 'Magic Missile', cost: s => (s.lvl < 5 ? 5 : '3–6') },
  second: { name: 'Second Chance', cost: () => 8 },
};
const spellCap = c => fxv(c, 'spellCap') || 15;
const spellNext = l => 5 + l * 4 + (l >= 10 ? l * 10 : 0);
// Add spell XP (combat casts count double) and handle level-ups and milestone messages.
function trainSpell(c, key, combat, bonus) {
  const s = c.spells[key],
    cap = spellCap(c);
  if (s.lvl >= cap) return;
  s.xp += (combat ? 2 : 1) + (bonus || 0);
  while (s.lvl < cap && s.xp >= spellNext(s.lvl)) {
    s.xp -= spellNext(s.lvl);
    s.lvl++;
    const who = c === G.pet ? NAMES.pet + '’s' : 'Your',
      She = c === G.pet ? 'She' : 'You',
      Her = c === G.pet ? 'Her' : 'Your';
    ai(
      `${who} ${SPELLS[key].name} spell is now level ${s.lvl}!` +
        (key == 'missile' && s.lvl == 5
          ? ` ${She} can now spend 3 to 6 mana per missile.`
          : key == 'missile' && s.lvl == 10
            ? ` ${Her} missiles can now set targets on fire.`
            : key == 'heal' && s.lvl == 5
              ? ' Heal is noticeably stronger now.'
              : ''),
    );
    if (key == 'missile' && s.lvl >= 3 && c === G.pet) award('mm3');
  }
}
// Per-turn upkeep for a crawler: mana regeneration, potion cooldown, poison damage.
function tick(c) {
  if (c.down) return;
  c.mpT++;
  if (c.mpT >= mpEvery(c)) {
    c.mpT = 0;
    if (c.mp < c.maxmp) c.mp++;
  }
  if (c.potCD > 0) c.potCD--;
  if (c.poison > 0) {
    c.poison--;
    const d = 1 + Math.floor(G.floor / 2);
    c.hp -= d;
    float(c.x, c.y, '-' + d, '#9be15d');
    if (c === G.player) {
      log(`Poison burns through you for ${d}.`, 'bad');
      if (c.hp <= 0) {
        c.hp = 0;
        die('Poisoned. The audience saw that coming before you did.');
      }
    } else if (c.hp <= 0) {
      c.hp = 0;
      c.down = true;
      log(`${NAMES.pet} succumbs to poison and is knocked out!`, 'bad');
    }
  }
}

// Lay out floor f in G.map: rooms, corridors and two boss lairs. The lairs are dead-end side rooms with a
// single doorway, picked from the far half of the floor, so the route from the start to the stairwell never
// runs through one and you can't stumble into a boss before you've had a chance to level up.
// Returns null if the layout fails validation; newFloor() just rolls again.
function layFloor(f) {
  const W = G.W,
    H = G.H;
  G.map.fill(WALL);
  const rooms = [];
  for (let t = 0; t < 1500 && rooms.length < 18 + f * 2; t++) {
    const w = R(5, 10),
      h = R(4, 7),
      x = R(1, W - w - 2),
      y = R(1, H - h - 2);
    if (rooms.some(r => x < r.x + r.w + 1 && x + w + 1 > r.x && y < r.y + r.h + 1 && y + h + 1 > r.y)) continue;
    rooms.push({ x, y, w, h, cx: x + (w >> 1), cy: y + (h >> 1) });
  }
  if (rooms.length < 12) return null;
  rooms.sort((a, b) => a.cx - b.cx);
  const start = rooms[0];
  // Lairs come from the far half of the floor (by straight-line distance), never the very farthest room.
  const far = r => Math.hypot(r.cx - start.cx, r.cy - start.cy);
  const farHalf = rooms
    .slice(1)
    .sort((a, b) => far(b) - far(a))
    .slice(1, Math.ceil(rooms.length / 2));
  const bossRoom = pick(farHalf);
  const rest = farHalf.filter(r => r !== bossRoom);
  const boroughRoom = pick(rest.filter(r => r.w >= 6 && r.h >= 5)) || pick(rest);
  const lairRooms = [bossRoom, boroughRoom].filter(Boolean);
  const plain = rooms.filter(r => !lairRooms.includes(r));
  for (const r of rooms)
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) G.map[idx(x, y)] = FLOOR;
  // L-shaped corridor paths between room centers
  const seg = (a, b, fixed, horiz) => {
    const o = [];
    for (let v = Math.min(a, b); v <= Math.max(a, b); v++) o.push(horiz ? [v, fixed] : [fixed, v]);
    return o;
  };
  const lPath = (a, b, hFirst) =>
    hFirst
      ? [...seg(a.cx, b.cx, a.cy, true), ...seg(a.cy, b.cy, b.cx, false)]
      : [...seg(a.cy, b.cy, a.cx, false), ...seg(a.cx, b.cx, b.cy, true)];
  const carve = path => {
    for (const [x, y] of path) G.map[idx(x, y)] = FLOOR;
  };
  const nearLair = ([x, y]) => lairRooms.some(r => x >= r.x - 1 && x <= r.x + r.w && y >= r.y - 1 && y <= r.y + r.h);
  // Join two ordinary rooms, taking whichever bend stays clear of the lairs.
  const link = (a, b) => {
    const o = Math.random() < 0.5,
      p1 = lPath(a, b, o),
      p2 = lPath(a, b, !o);
    carve(p1.some(nearLair) && !p2.some(nearLair) ? p2 : p1);
  };
  for (let i = 1; i < plain.length; i++) link(plain[i - 1], plain[i]);
  for (let i = 0; i < 3 + f; i++) link(pick(plain), pick(plain));
  // Each lair gets one spur from its nearest ordinary room; every other gap in its wall is bricked up.
  for (const r of lairRooms) {
    const from = plain.slice().sort((a, b) => Math.hypot(a.cx - r.cx, a.cy - r.cy) - Math.hypot(b.cx - r.cx, b.cy - r.cy))[0];
    const path = lPath(from, r, Math.random() < 0.5);
    carve(path);
    const ring = (x, y) =>
      x >= r.x - 1 && x <= r.x + r.w && y >= r.y - 1 && y <= r.y + r.h && !inRoom(r, x, y);
    let door = null;
    for (const [x, y] of path) if (ring(x, y)) door = [x, y];
    for (let y = r.y - 1; y <= r.y + r.h; y++)
      for (let x = r.x - 1; x <= r.x + r.w; x++)
        if (ring(x, y) && !(door && x == door[0] && y == door[1])) G.map[idx(x, y)] = WALL;
  }
  // Validate: with the lairs blocked, every ordinary room must still be reachable from the start,
  // and each lair's doorway must be reachable and not too close to the start.
  const bfs = block => {
    const dist = new Int32Array(W * H).fill(-1),
      q = [idx(start.cx, start.cy)];
    dist[q[0]] = 0;
    for (let h = 0; h < q.length; h++) {
      const i = q[h],
        x = i % W,
        y = (i / W) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx,
          ny = y + dy,
          n = idx(nx, ny);
        if (tile(nx, ny) == WALL || dist[n] >= 0) continue;
        if (block && lairRooms.some(r => inRoom(r, nx, ny))) continue;
        dist[n] = dist[i] + 1;
        q.push(n);
      }
    }
    return dist;
  };
  const dist = bfs(true),
    open = bfs(false),
    d = r => dist[idx(r.cx, r.cy)];
  if (plain.some(r => d(r) < 0) || lairRooms.some(r => open[idx(r.cx, r.cy)] < 0)) return null;
  const others = plain.slice(1).sort((a, b) => d(b) - d(a));
  const stairRoom = others[0],
    maxD = d(stairRoom);
  if (lairRooms.some(r => open[idx(r.cx, r.cy)] < maxD * 0.4)) return null;
  const safeRoom = others.slice(1).sort((a, b) => Math.abs(d(a) - maxD / 2) - Math.abs(d(b) - maxD / 2))[0];
  return { rooms, start, stairRoom, safeRoom, bossRoom, boroughRoom };
}

// Generate floor f and place everyone on it (layout from layFloor). Stairwell is the farthest ordinary room,
// the safe room sits about halfway there.
function newFloor(f) {
  G.floor = f;
  const W = (G.W = 64 + f * 6),
    H = (G.H = 42 + f * 4);
  G.map = new Uint8Array(W * H);
  G.seen = new Uint8Array(W * H);
  G.vis = new Uint8Array(W * H);
  G.mobs = [];
  G.items = [];
  G.corpses = [];
  G.hoodsMapped = new Set();
  G.janitorMsg = 0;
  G.stairsKnown = false;
  G.safeVisited = false;
  G.inSafe = false;
  G.floorKills = 0;
  G.floorViews = G.views;
  // Bigger floors with more to fight need a longer clock.
  G.turns = G.turnsMax = 1000 + f * 200;
  G.camX = null;
  G.floorHurt = false;
  let L = null;
  for (let attempt = 0; !L && attempt < 60; attempt++) L = layFloor(f);
  const { rooms, start, stairRoom, safeRoom, bossRoom, boroughRoom } = L;
  G.lairs = [];
  for (let y = safeRoom.y; y < safeRoom.y + safeRoom.h; y++)
    for (let x = safeRoom.x; x < safeRoom.x + safeRoom.w; x++) G.map[idx(x, y)] = SAFE;
  G.map[idx(stairRoom.cx, stairRoom.cy)] = STAIRS;
  G.stairs = { x: stairRoom.cx, y: stairRoom.cy };
  const freeIn = r => {
    for (let t = 0; t < 40; t++) {
      const x = R(r.x, r.x + r.w - 1),
        y = R(r.y, r.y + r.h - 1);
      if (tile(x, y) == FLOOR && !mobAt(x, y) && !itemAt(x, y)) return { x, y };
    }
    return null;
  };
  const pool = spawnPool(f);
  for (const r of rooms) {
    if (r === start || r === safeRoom || r === bossRoom || r === boroughRoom) continue;
    const n = R(1, 3 + (f > 1 ? 1 : 0));
    for (let i = 0; i < n; i++) {
      const pos = freeIn(r);
      if (!pos) continue;
      const t = pickW(pool);
      G.mobs.push(mkMob(t, mobLevel(t.lvl, f) + (Math.random() < 0.25 ? 1 : 0), pos));
    }
  }
  const makeLair = (room, tpl, lvl, minions) => {
    if (!room) return;
    const pos = { x: room.cx, y: room.cy };
    const b = mkMob(tpl, lvl, pos);
    b.room = room;
    G.mobs.push(b);
    const lair = { room, boss: b, sealed: false, bar: [], minions: [] };
    for (let i = 0; i < minions; i++) {
      const mp = freeIn(room);
      if (!mp) continue;
      const t = pickW(pool.filter(([, t]) => t.rank <= 2));
      const mm = mkMob(t, mobLevel(t.lvl, f), mp);
      mm.room = room;
      mm.minionOf = b;
      lair.minions.push(mm);
      G.mobs.push(mm);
    }
    b.lair = lair;
    G.lairs.push(lair);
    return b;
  };
  // The first Neighborhood Boss is a level gentler: it's the crawlers' first real test.
  const nb = makeLair(bossRoom, BOSS, mobLevel(BOSS.lvl, f) + (f > 1 ? 1 : 0), 2);
  if (nb && f > 1) {
    nb.name = pick(['Chef Rancid', 'The Gravy Baron', 'Sister Mildew']);
    nb.desc = `${nb.name} runs this floor’s neighborhood like a cafeteria from your worst nightmares. The menu is you.`;
  }
  if (boroughRoom) {
    const sx2 = boroughRoom.x + boroughRoom.w - 1,
      sy2 = boroughRoom.y + boroughRoom.h - 1;
    G.map[idx(sx2, sy2)] = STAIRS;
    const bb = makeLair(boroughRoom, BOROUGH, mobLevel(BOROUGH.lvl, f), 3);
    if (bb && f > 1) {
      const [n, d0] = BOROUGH_ALT[(f - 2) % BOROUGH_ALT.length];
      bb.name = n;
      bb.desc = d0 + ' It guards a stairwell.';
    }
  }
  for (let i = 0; i < 10 + f * 2; i++) {
    const r = pick(rooms.slice(1));
    const pos = freeIn(r);
    if (pos) G.items.push({ ...pos, k: pick(['potion', 'potion', 'bomb', 'bomb', 'box_bronze', 'potion', 'potion']) });
  }
  const p = G.player;
  p.x = start.cx;
  p.y = start.cy;
  if (f == 1 && !G.hud) {
    for (const [dx, dy] of [
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
      [2, 1],
      [1, 2],
    ]) {
      const x = p.x + dx,
        y = p.y + dy;
      if (tile(x, y) == FLOOR && !itemAt(x, y) && !mobAt(x, y)) {
        G.items.push({ x, y, k: 'sign' });
        break;
      }
    }
  }
  const pt = G.pet;
  const spot = DIRS.map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy })).find(
    s => tile(s.x, s.y) != WALL && !mobAt(s.x, s.y),
  ) || { x: p.x, y: p.y };
  pt.x = spot.x;
  pt.y = spot.y;
  fov();
  ai(
    f == 1
      ? `Welcome to the dungeon, crawler! This is Floor 1. Find a stairwell before the timer runs out. Kill things. Be entertaining.`
      : `Floor ${f}. It is bigger, meaner, and the clock is already running.`,
  );
  ui();
  if (f >= 3 && !G.chosen) startSelection();
}

// =====================================================================================================
// FIELD OF VIEW
// =====================================================================================================
function los(x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0),
    dy = -Math.abs(y1 - y0),
    sx = x0 < x1 ? 1 : -1,
    sy = y0 < y1 ? 1 : -1,
    e = dx + dy,
    x = x0,
    y = y0;
  while (!(x == x1 && y == y1)) {
    if ((x != x0 || y != y0) && tile(x, y) == WALL) return false;
    const e2 = 2 * e;
    if (e2 >= dy) {
      e += dy;
      x += sx;
    }
    if (e2 <= dx) {
      e += dx;
      y += sy;
    }
  }
  return true;
}
// Recompute what Carl can see (radius 7) and remember everything seen for the map.
function fov() {
  G.vis.fill(0);
  const { x: px, y: py } = G.player,
    r = 7;
  for (let y = py - r; y <= py + r; y++)
    for (let x = px - r; x <= px + r; x++) {
      if (x < 0 || y < 0 || x >= G.W || y >= G.H || (x - px) ** 2 + (y - py) ** 2 > r * r + 2) continue;
      if (los(px, py, x, y)) {
        const i = idx(x, y);
        G.vis[i] = 1;
        G.seen[i] = 1;
        if (G.map[i] == STAIRS) {
          if (!G.stairsKnown) award('stairs');
          G.stairsKnown = true;
        }
      }
    }
}

// =====================================================================================================
// MESSAGES
// =====================================================================================================
const logEl = $('#log');
// Add a message to the log. Repeats of the same line collapse into one with a ×N counter.
function log(m, c = '') {
  const last = G.log[G.log.length - 1];
  if (last && last[2] === m) {
    last[3] = (last[3] || 1) + 1;
    last[0] = `${m} <span class="dim">(×${last[3]})</span>`;
  } else G.log.push([m, c, m]);
  if (G.log.length > 150) G.log.shift();
  logDirty = true;
  needsDraw = true;
}
// Rebuild the log panel at most once per animation frame (many messages can arrive in one turn).
let logDirty = false;
function flushLog() {
  if (!logDirty || !G) return;
  logDirty = false;
  logEl.innerHTML = G.log
    .slice(-70)
    .map(([a, b]) => `<p class="${b}">${a}</p>`)
    .join('');
  logEl.scrollTop = 1e9;
}
const ai = m => log(m, 'ai');
// Donut comments on events, rate-limited so she doesn't talk every turn (force bypasses the limit).
function petSay(k, force) {
  if (G.pet.down) return;
  if (!force && G.petTalk > 0) return;
  G.petTalk = 6;
  log(`${NAMES.pet}: “${pick(PETL[k])}”`, 'pet');
}
let toastT;
// Brief banner at the top of the map (achievements, sponsors).
function toast(sub, txt) {
  const t = $('#toast');
  t.innerHTML = `<small>${sub}</small><b>${txt}</b>`;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2800);
}
// Floating damage/heal number over a tile (drawn only if the tile is visible).
function float(x, y, txt, col) {
  G.fx.push({ k: 'f', x, y, txt: String(txt), col, t: performance.now() });
}

// Add views (boosted by class bonuses). Every follower milestone attracts a patron and a Benefactor Box.
function addViews(n) {
  G.views += Math.round(n * (1 + fxv(G.player, 'views') + fxv(G.pet, 'views')));
  while (followers() >= G.nextSponsor) {
    const c = Math.random() < 0.5 ? G.player : G.pet;
    const bx = pick(['silver', 'silver', 'gold', 'gold', 'platinum']) + '|Benefactor';
    c.boxes.push(bx);
    const sp = pick(SPONSORS);
    ai(
      `${sp} has become a patron of ${c === G.player ? 'yours' : c.name}! A ${boxLabel(bx)} has been added to ${c === G.player ? 'your' : 'her'} inventory. Benefactor Boxes hold the rarest gear in the game.`,
    );
    toast(`New sponsor for ${c.name}`, sp);
    G.nextSponsor = Math.round(G.nextSponsor * 2.2);
  }
}
// Grant an achievement once: log it, add its loot box (if any) to the owner, toast it and add views.
// quiet=true skips the toast and views (used for the batch of entry achievements).
function award(id, quiet) {
  if (G.ach.has(id) || !ACH[id]) return;
  G.ach.add(id);
  const [n, t, tier, who, type] = ACH[id],
    c = who == 'pet' ? G.pet : G.player,
    bx = tier == 'none' ? null : `${tier}|${type || 'Adventurer'}`;
  if (bx) c.boxes.push(bx);
  ai(
    `${who == 'pet' ? NAMES.pet + ' earned a new achievement' : 'New achievement'}! <b>${n}</b>. ${t} Reward: ${bx ? boxLabel(bx) + (who == 'pet' ? ' (hers)' : '') : 'none. Congratulations anyway'}.`,
  );
  if (!quiet) {
    toast(who == 'pet' ? `${NAMES.pet} · new achievement` : 'New achievement', n);
    addViews(
      { none: 200, bronze: 300, silver: 700, gold: 1500, platinum: 3000, legendary: 6000, celestial: 12000 }[tier],
    );
  }
}
// Give XP and process level-ups. Carl banks 3 stat points per level until race/class selection;
// Donut's Enhanced Growth applies +1 STR, +1 INT, +2 CHA automatically.
function gainXP(c, n) {
  if (c.down && c === G.pet) return;
  c.xp += Math.round(n);
  while (c.xp >= c.next) {
    c.xp -= c.next;
    c.lvl++;
    // Gentle early curve (20, 36, 58, 87, 126 ...) so a well-explored floor is worth a few levels.
    c.next = Math.round(c.next * 1.35 + 9);
    if (c === G.pet) {
      c.str++;
      c.int++;
      c.cha += 2;
    } else if (G.chosen) c.pts += 3;
    else c.bank += 3;
    recalc(c);
    c.hp = Math.min(c.maxhp, c.hp + Math.round(c.maxhp * 0.3));
    c.mp = c.maxmp;
    if (c === G.player) {
      ai(
        `Level up! You are now level ${c.lvl}. ` +
          (G.chosen
            ? `You have ${c.pts} stat points to assign.`
            : `3 stat points banked (${c.bank} total). They’ll be applied when you choose a race and class on Floor 3.`),
      );
      petSay('lvl', true);
      if (c.lvl == 2) award('level2');
      if (c.lvl >= 3) award('lvl3');
    } else {
      ai(`${NAMES.pet} is now level ${c.lvl}! Enhanced Growth: +1 STR, +1 INT, +2 CHA.`);
      log(
        `${NAMES.pet}: “${pick(['Obviously.', 'Level ' + c.lvl + '. Write that down.', 'My charisma is becoming a problem for other people.'])}”`,
        'pet',
      );
      if (c.lvl >= 3) award('pet_lvl3');
    }
  }
}

// =====================================================================================================
// COMBAT
// =====================================================================================================
function playerAttack(m) {
  const p = G.player;
  m.awake = true;
  provoke(m);
  const unarmed = p.gear.weapon.t < 0 || /Knuckle/.test(p.gear.weapon.n);
  const hit = Math.max(50, Math.min(95, 70 + st(p, 'dex') * 2 - m.dodge));
  if (Math.random() * 100 >= hit) {
    log(`You swing at the ${m.name} and miss.`, 'dim');
    float(m.x, m.y, 'miss', '#a897bb');
    return;
  }
  let d = Math.max(
    1,
    R(1, 4) +
      p.gear.weapon.v +
      Math.floor(st(p, 'str') / 3) -
      effArm(m) +
      fxv(p, 'melee') +
      (unarmed ? fxv(p, 'unarmed') : 0),
  );
  if (fxv(p, 'rage') && p.hp < p.maxhp * 0.4) d = Math.round(d * (1 + fxv(p, 'rage')));
  const crit =
    Math.random() * 100 < 2 + st(p, 'dex') + cb(p, 'crit') + fxv(p, 'crit') + (unarmed ? fxv(p, 'unarmedCrit') : 0);
  if (crit) {
    d *= fxv(p, 'critMul') || 2;
    addViews(150);
    award('crit');
  }
  if (m.boss) award('boss_babe');
  award('dmg_first');
  G.floorHurt = true;
  m.hp -= d;
  float(m.x, m.y, (crit ? 'CRIT ' : '') + d, crit ? '#f5c542' : '#fff');
  log(`You hit the ${m.name} for ${d}${crit ? '. Critical hit!' : '.'}`);
  if (m.hp > 0 && Math.random() < fxv(p, 'poisonHit')) {
    m.psn = 3;
    log(`Your rat-kin bite leaves the ${m.name} poisoned.`);
  }
  if (m.hp <= 0) kill(m, 'hero');
}
// Monster m attacks crawler t (Carl or Donut). Crawlers in safe rooms can't be hit.
function mobAttack(m, t) {
  if (tile(t.x, t.y) == SAFE) return;
  if (t === G.player) {
    const p = G.player;
    if (
      Math.random() * 100 >=
      Math.max(30, Math.min(95, 85 - st(p, 'dex') * 2 + (m.level - p.lvl) * 2 - fxv(p, 'dodge')))
    ) {
      log(`The ${m.name} misses you.`, 'dim');
      float(p.x, p.y, 'miss', '#a897bb');
      return;
    }
    const d = Math.max(1, Math.round(R(m.lo, m.hi) * mul(m)) - p.gear.armor.v - fxv(p, 'armor'));
    p.hp -= d;
    vampHeal(m, d);
    if (m.role == 'janitor' && Math.random() < 0.2 && p.hp > 0) {
      p.poison = Math.max(p.poison, 4);
      log(`The ${m.name}’s bite is filthy. You are poisoned!`, 'bad');
    }
    G.shake = reduced ? 0 : 6;
    float(p.x, p.y, '-' + d, '#ff5a6e');
    log(`The ${m.name} hits you for ${d}.`, 'bad');
    if (p.hp <= 0) {
      p.hp = 0;
      die(`Killed by ${m.boss ? m.name : 'a ' + m.name} on Floor ${G.floor}.`);
    } else if (p.hp <= p.maxhp * 0.25) petSay('low');
  } else {
    const pt = G.pet;
    if (Math.random() * 100 >= Math.max(30, 80 - st(pt, 'dex') * 2)) {
      float(pt.x, pt.y, 'miss', '#a897bb');
      return;
    }
    const d = Math.max(1, Math.round(R(m.lo, m.hi) * mul(m)) - pt.gear.armor.v);
    pt.hp -= d;
    vampHeal(m, d);
    if (m.role == 'janitor' && Math.random() < 0.2) pt.poison = Math.max(pt.poison, 4);
    float(pt.x, pt.y, '-' + d, '#ffa5d0');
    if (pt.hp <= 0) {
      pt.hp = 0;
      pt.down = true;
      log(`${NAMES.pet} is knocked out! Rest in a safe room to revive her.`, 'bad');
    } else if (Math.random() < 0.3) petSay('hurt');
  }
}
// Boss rewards: a Boss Box per crawler (Bronze for Neighborhood, Silver for Borough), a star, persistent loot, Survivor's Boxes
function bossDefeated(m) {
  const L = m.lair,
    borough = m.tier == 'Borough',
    tier = borough ? 'silver' : 'bronze',
    p = G.player,
    pt = G.pet;
  if (borough) award('borough');
  else award('boss');
  const lines = [];
  for (const c of [p, pt]) {
    c.boxes.push(tier + '|Boss');
    c.stars = c.stars || { bronze: 0, silver: 0 };
    c.stars[tier]++;
    let l = `<b>${c.name}</b>: ${cap(tier)} Boss Box and a ${tier} star`;
    if (!c.down) {
      const f = c.hp / c.maxhp;
      if (f < 0.05) {
        c.boxes.push('silver|Survivor’s');
        l += ', plus a Silver Survivor’s Box for finishing under 5% HP';
      } else if (f < 0.1) {
        c.boxes.push('bronze|Survivor’s');
        l += ', plus a Bronze Survivor’s Box for finishing under 10% HP';
      }
    }
    lines.push(l);
  }
  dropNear(m.x, m.y, borough ? 'guide' : 'map');
  let dead = 0;
  if (L) {
    for (const o of L.minions)
      if (!o.dead) {
        o.dead = true;
        G.mobs = G.mobs.filter(x => x !== o);
        G.corpses.push({ x: o.x, y: o.y, name: o.name, age: 0 });
        dead++;
      }
    const was = L.sealed;
    unseal(L);
    if (was) {
      modal(
        `<div class="sub">The world freezes</div><h2>WINNER!</h2><p>${m.tier} Boss <b>${m.name}</b> (level ${m.level}) has been defeated by ${NAMES.hero} and ${NAMES.pet}.</p><ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul><p>${m.name} left behind persistent loot: a <b>${borough ? 'Borough Field Guide' : 'Neighborhood Map'}</b>. Pick it up from the floor.${dead ? ` Its ${dead} remaining minion${dead > 1 ? 's' : ''} dropped dead.` : ''}</p>`,
        [{ label: 'Collect your winnings', primary: 1 }],
      );
      return;
    }
  }
  ai(
    `${m.tier} Boss ${m.name} has been defeated! No announcement, since you never set foot in the lair, but the boxes and stars are yours.`,
  );
  toast('Boss defeated', m.name);
}
// Lairs seal when a crawler walks in; nobody leaves until the boss is dead
// A boss and its minions sit behind the lair's System barrier until the lair seals: nothing outside can hurt
// them (melee, spells, bombs, fire, other monsters) and they don't attack out through the doorway.
function shielded(m) {
  const L = m.lair || (m.minionOf && m.minionOf.lair);
  return !!L && !L.sealed && G.mobs.includes(L.boss);
}
function checkLair() {
  const p = G.player;
  for (const L of G.lairs) {
    if (L.sealed || !G.mobs.includes(L.boss) || !inRoom(L.room, p.x, p.y)) continue;
    const r = L.room;
    L.sealed = true;
    for (let y = r.y - 1; y <= r.y + r.h; y++)
      for (let x = r.x - 1; x <= r.x + r.w; x++) {
        if (inRoom(r, x, y)) continue;
        const i = idx(x, y);
        if (G.map[i] == WALL) continue;
        // A monster standing in the doorway is nudged outward; if it can't move, that doorway stays open.
        const blocker = mobAt(x, y);
        if (blocker && !nudgeOut(blocker, r)) continue;
        L.bar.push([i, G.map[i]]);
        G.map[i] = WALL;
      }
    // Donut is pulled into the lair with Carl (next to him if possible, otherwise anywhere free inside).
    const pt = G.pet;
    if (!pt.down && !inRoom(r, pt.x, pt.y)) {
      const spot = freeTileIn(r, p) || freeTileIn(r);
      if (spot) {
        pt.x = spot.x;
        pt.y = spot.y;
      }
    }
    const b = L.boss;
    b.awake = true;
    L.minions.forEach(o => (o.awake = true));
    if (b.tier == 'Borough') award('borough_found');
    fov();
    const card = c => `<div class="pcard"><b>${c.name}</b><span>Level ${c.lvl}</span></div>`;
    modal(
      `<div class="sub">The door seals behind you. Music starts playing.</div><h2>B-B-B-Boss Battle!</h2><div class="vs">${card(p)}${card(pt)}<em>vs</em><div class="pcard boss"><b>${b.name}</b><span>Level ${b.level} · ${b.tier} Boss</span></div></div><p class="aidesc">${b.desc}</p><p class="lvl">Bosses can’t leave their lairs, and neither can you until this is over.</p>`,
      [{ label: 'Fight!', primary: 1 }],
    );
    return;
  }
}
// Move a doorway-blocking monster to a free tile just outside the lair. Returns false if there is none.
function nudgeOut(m, r) {
  for (const [dx, dy] of DIRS) {
    const nx = m.x + dx,
      ny = m.y + dy;
    const ring = nx >= r.x - 1 && nx <= r.x + r.w && ny >= r.y - 1 && ny <= r.y + r.h;
    if (!ring && tile(nx, ny) == FLOOR && !occupied(nx, ny, m)) {
      m.x = nx;
      m.y = ny;
      return true;
    }
  }
  return false;
}
// A free floor tile inside room r — adjacent to `near` if given.
function freeTileIn(r, near) {
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++)
      if ((!near || cheb({ x, y }, near) == 1) && tile(x, y) != WALL && !occupied(x, y, G.pet)) return { x, y };
  return null;
}
// Reopen a sealed lair's doorways.
function unseal(L) {
  if (!L || !L.sealed) return;
  for (const [i, t] of L.bar) G.map[i] = t;
  L.bar = [];
  L.sealed = false;
  fov();
}
const sealedLair = () => G.lairs.find(L => L.sealed);
// Drop an item on a tile if it's free.
function drop(x, y, k) {
  if (!itemAt(x, y) && tile(x, y) != WALL) G.items.push({ x, y, k });
}
// Drop an item on the tile or the first free neighbor.
function dropNear(x, y, k) {
  for (const [dx, dy] of [[0, 0], ...DIRS]) {
    const nx = x + dx,
      ny = y + dy;
    if (tile(nx, ny) != WALL && !itemAt(nx, ny)) {
      G.items.push({ x: nx, y: ny, k });
      return;
    }
  }
}
// Every death leaves a corpse. If no janitor is nearby, the dungeon sends a few rats to clean up.
function afterDeath(m, by) {
  if (m.loot && m.loot.length) {
    m.loot.forEach(k => dropNear(m.x, m.y, k));
    if (G.vis[idx(m.x, m.y)])
      log(
        `The ${m.name} bursts open and spills ${m.loot.length} item${m.loot.length > 1 ? 's' : ''} it had vacuumed up.`,
        'kill',
      );
  }
  if (!G.corpses.some(c => c.x == m.x && c.y == m.y)) G.corpses.push({ x: m.x, y: m.y, name: m.name, age: 0 });
  if (m.role != 'janitor' && !G.mobs.some(o => o.role == 'janitor' && cheb(o, m) <= 12)) {
    const n = R(1, 3);
    let made = 0;
    for (let t = 0; t < 80 && made < n; t++) {
      const x = m.x + R(-14, 14),
        y = m.y + R(-14, 14),
        d = Math.max(Math.abs(x - m.x), Math.abs(y - m.y));
      if (d < 6 || tile(x, y) != FLOOR || G.vis[idx(x, y)] || occupied(x, y, null)) continue;
      const r = mkMob(typeObj('rat', 0), mobLevel(1, G.floor), { x, y });
      r.awake = false;
      G.mobs.push(r);
      made++;
    }
    if (made && !G.janitorMsg) {
      G.janitorMsg = 1;
      ai('A body has hit the floor. Janitor rats have been dispatched to your area. Please do not feed the janitors.');
    }
  }
  if (m.neutral && by != 'mob') {
    for (const o of G.mobs)
      if (o.fam == m.fam && !o.hostile && !o.ally && cheb(o, m) <= 10) {
        o.hostile = true;
        o.awake = true;
      }
  }
  if (m.fam == 'goblin' && by != 'mob') {
    let woke = 0;
    for (const o of G.mobs)
      if (o.fam == 'goblin' && !o.charmed && !o.awake && cheb(o, m) <= 14) {
        o.awake = true;
        woke++;
      }
    if (woke)
      log(`The goblin clan heard that. ${woke} more goblin${woke > 1 ? 's are' : ' is'} coming for you.`, 'bad');
  }
}
// Remove a dead mob and hand out credit. `by` is who killed it:
//   'hero' (Carl's melee), 'spell' (Carl's missile, poison or fire), 'bomb' (Carl's bomb),
//   'pet' (Donut's scratch), 'missile' (Donut's spell or fire), 'mob' (another monster; `src` is the killer).
function kill(m, by, src) {
  if (m.dead) return;
  m.dead = true;
  G.mobs = G.mobs.filter(o => o !== m);
  const p = G.player,
    pt = G.pet;
  if (m.ally) {
    // Donut's undead minion: no corpse, XP or credit for anyone
    if (seen(m)) log(`The ${m.name} is destroyed.`, 'pet');
    return;
  }
  if (by == 'mob' && src && src.ally) by = 'pet'; // kills by Donut's undead minion count as hers
  const byPet = by == 'pet' || by == 'missile';
  afterDeath(m, by);
  if (by == 'mob') {
    // A boss killed by its own side still has to unseal its lair and pay out
    if (m.boss) bossDefeated(m);
    if (G.vis[idx(m.x, m.y)]) {
      if (src && src.fam && src.fam == m.fam) {
        log(`The ${m.name} is killed by its own side.`, 'kill');
        award('friendly_fire');
      } else if (src) {
        log(
          `The ${src.name} kills the ${m.name}.${src.faction && m.faction ? ' The turf war continues.' : ''}`,
          'kill',
        );
        if (src.faction && m.faction) award('turf_war');
      } else log(`The ${m.name} dies.`, 'kill');
      addViews(m.xp * 20);
    }
    return;
  }
  G.kills++;
  G.floorKills++;
  log(`The ${m.name} dies.${byPet ? ` ${NAMES.pet} gets the kill.` : ''}`, 'kill');
  // Wiki: your first kill unlocks the ability to earn experience. After that the killer gets full XP and the partner a 25% share;
  // boss XP is split among everyone present (70% each).
  const share = (c, n) => {
    if (c.xpOn && !c.down) {
      gainXP(c, n);
      award('share_xp');
    }
  };
  if (m.boss) {
    if (byPet) pt.kills++;
    else p.kills++;
    for (const c of [p, pt]) if (c.xpOn) gainXP(c, m.xp * 0.7);
  } else if (byPet) {
    pt.kills++;
    if (pt.xpOn) gainXP(pt, m.xp);
    else pt.xpOn = true;
    share(p, m.xp * 0.25);
  } else {
    p.kills++;
    if (p.xpOn) gainXP(p, m.xp);
    else {
      p.xpOn = true;
      award('first_blood');
    }
    share(pt, m.xp * 0.25);
  }
  let v = m.xp * R(30, 60);
  if (m.boss) v *= 4;
  if (byPet) {
    if (pt.hp <= pt.maxhp * 0.25) {
      v *= 2;
      award('pet_clutch');
    }
    award('pet_kill');
    if (by == 'missile') award('pet_missile');
    if (pt.kills >= 10) award('pet_ten');
    if (m.boss) award('pet_boss');
    petSay('kill');
  } else {
    if (p.hp > 0 && p.hp <= p.maxhp * 0.25) {
      v *= 2;
      award('clutch');
    }
    if (p.kills >= 10) award('ten');
    if (m.level > p.lvl) award('higher');
    // only Carl's actual fists count for this one
    if (by == 'hero' && p.gear.weapon.t < 0 && (m.boss || m.fam == 'goblin' || (m.fam == 'rat' && m.role != 'janitor')))
      award('bare_hands');
    if (by == 'bomb') {
      p.bombKills++;
      if (p.bombKills > 10) award('boom10');
    }
  }
  if (m.role == 'support') award('priority');
  if (m.role == 'janitor' && m.eaten >= 3) award('fat_rat');
  addViews(v);
  if (m.boss) bossDefeated(m);
  else {
    const r = Math.random();
    if (r < 0.14) drop(m.x, m.y, 'potion');
    else if (r < 0.2) drop(m.x, m.y, 'bomb');
    else if (r < 0.24) drop(m.x, m.y, 'box_bronze');
    maybeRaise(m);
  }
}
// NecroBard's Second Chance: raise a freshly killed mob as a temporary undead minion
function maybeRaise(m) {
  const pt = G.pet,
    s = pt.spells.second;
  if (
    !s ||
    pt.down ||
    !m.fam ||
    G.mobs.some(o => o.ally) ||
    pt.mp < 8 ||
    cheb(pt, m) > 6 ||
    tile(m.x, m.y) == SAFE ||
    tile(pt.x, pt.y) == SAFE ||
    occupied(m.x, m.y, null)
  )
    return;
  pt.mp -= 8;
  G.corpses = G.corpses.filter(c => !(c.x == m.x && c.y == m.y));
  const u = mkMob(typeObj(m.fam, m.rank - 1), m.level, { x: m.x, y: m.y });
  Object.assign(u, { ally: true, hostile: false, awake: true, timer: 10 + s.lvl * 2, name: 'Undead ' + m.name });
  G.mobs.push(u);
  G.fx.push({ k: 'bolt', a: { x: pt.x, y: pt.y }, b: { x: m.x, y: m.y }, t: performance.now(), col: '#5fe0d0' });
  log(
    `${NAMES.pet} glows purple and casts Second Chance (8 MP). The ${m.name} climbs back up as her undead minion for ${u.timer} turns.`,
    'pet',
  );
  trainSpell(pt, 'second', true);
  award('second_chance');
}

// =====================================================================================================
// MOVEMENT / AI
// =====================================================================================================
const HOODN = ['northwest', 'northeast', 'southwest', 'southeast'];
const hoodOf = (x, y) => (x < G.W / 2 ? 0 : 1) + (y < G.H / 2 ? 0 : 2);
const inRoom = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
// Greedy step toward a target (no pathfinding). Mobs can't enter safe rooms; lair monsters stay in their room.
function stepToward(e, tx, ty, isPet) {
  let best = null,
    bd = (e.x - tx) ** 2 + (e.y - ty) ** 2;
  for (const [dx, dy] of DIRS) {
    const nx = e.x + dx,
      ny = e.y + dy,
      t = tile(nx, ny);
    if (t == WALL || (!isPet && t == SAFE) || occupied(nx, ny, e) || (e.room && !inRoom(e.room, nx, ny))) continue;
    const dd = (nx - tx) ** 2 + (ny - ty) ** 2;
    if (dd < bd) {
      bd = dd;
      best = [nx, ny];
    }
  }
  if (best) {
    e.x = best[0];
    e.y = best[1];
  } else if (Math.random() < 0.3) randStep(e, isPet);
}
// Random step, respecting the same movement rules.
function randStep(e, isPet) {
  const [dx, dy] = pick(DIRS),
    nx = e.x + dx,
    ny = e.y + dy,
    t = tile(nx, ny);
  if (t != WALL && (isPet || t != SAFE) && !occupied(nx, ny, e) && !(e.room && !inRoom(e.room, nx, ny))) {
    e.x = nx;
    e.y = ny;
  }
}
// Donut's turn: eat kibble when hurt, scratch an adjacent hostile, else Magic Missile the best target
// (support casters first), else follow Carl.
function petAct() {
  const pt = G.pet,
    p = G.player;
  if (pt.down) return;
  // Kibble works like a potion: it respects her CON-based potion cooldown
  if (pt.hp < pt.maxhp * 0.35 && pt.inv.kibble > 0 && pt.potCD == 0) {
    pt.inv.kibble--;
    pt.potCD = potionCD(pt);
    pt.poison = 0;
    const h = Math.round(pt.maxhp * 0.5);
    pt.hp = Math.min(pt.maxhp, pt.hp + h);
    float(pt.x, pt.y, '+' + h, '#7ef0a0');
    log(`${NAMES.pet} wolfs down a Kibble of Mending and recovers ${h} HP.`, 'pet');
    award('pet_snack');
    return;
  }
  const hostile = m => m.hostile && !m.charmed && !m.ally && !shielded(m);
  const adj = G.mobs.filter(m => hostile(m) && cheb(m, pt) == 1);
  if (adj.length) {
    const m = adj.sort((a, b) => a.hp - b.hp)[0];
    m.awake = true;
    if (Math.random() * 100 < Math.max(50, Math.min(95, 70 + st(pt, 'dex') * 2 - m.dodge))) {
      let d = Math.max(1, R(1, 3) + pt.gear.weapon.v + Math.floor(st(pt, 'str') / 4) - effArm(m) + fxv(pt, 'scratch'));
      const crit = Math.random() * 100 < 2 + st(pt, 'dex') + fxv(pt, 'crit');
      G.floorHurt = true;
      if (crit) {
        d *= 2;
        addViews(120);
        award('pet_crit');
      }
      m.hp -= d;
      float(m.x, m.y, (crit ? 'CRIT ' : '') + d, crit ? '#f5c542' : '#ffa5d0');
      log(`${NAMES.pet} scratches the ${m.name} for ${d}${crit ? '. Critical!' : '.'}`, 'pet');
      if (m.hp <= 0) kill(m, 'pet');
    } else {
      float(m.x, m.y, 'miss', '#a897bb');
    }
    return;
  }
  // Magic Missile: costs mana, can miss, scales with mana spent; no casting inside safe rooms
  if (tile(pt.x, pt.y) != SAFE) {
    const pri = m => cheb(m, pt) - (m.role == 'support' ? 6 : KITERS[m.role] ? 3 : 0),
      tg = G.mobs
        .filter(m => hostile(m) && G.vis[idx(m.x, m.y)] && cheb(m, pt) <= 7 && los(pt.x, pt.y, m.x, m.y))
        .sort((a, b) => pri(a) - pri(b));
    if (tg.length && fireMissile(pt, tg[0])) return;
  }
  if (cheb(pt, p) > 10) {
    const s = DIRS.map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy })).find(
      s => tile(s.x, s.y) != WALL && !occupied(s.x, s.y, pt),
    );
    if (s) {
      pt.x = s.x;
      pt.y = s.y;
    }
  } else if (cheb(pt, p) > 2) {
    // Follow Carl along a real path so walls and corners don't strand her (greedy step as a fallback).
    // If she's been out of his sight for 3 turns (a long detour, or blocked by monsters), she slips
    // through a gap and catches up, like any good RPG companion.
    pt.lost = G.vis[idx(pt.x, pt.y)] ? 0 : (pt.lost || 0) + 1;
    const spot =
      pt.lost >= 3 &&
      DIRS.map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy })).find(
        s => tile(s.x, s.y) != WALL && !occupied(s.x, s.y, pt),
      );
    if (spot) {
      pt.x = spot.x;
      pt.y = spot.y;
      pt.lost = 0;
      log(`${NAMES.pet} squeezes through a gap and catches up. “You could have waited.”`, 'pet');
    } else if (!pathStep(pt, p.x, p.y, 40, true)) stepToward(pt, p.x, p.y, true);
  } else {
    pt.lost = 0;
    if (Math.random() < 0.15) randStep(pt, true); // idle fidget when she's already close
  }
}
// Mana cost of a Magic Missile at mob m: 5 MP below spell level 5; from level 5 the caster spends
// just enough (3-6 MP) to finish the target. Class modifiers apply.
function missileCost(c, m) {
  const s = c.spells.missile,
    bonus = s.lvl + Math.floor(st(c, 'int') / 4) + fxv(c, 'missile');
  let cost = 5;
  if (s.lvl >= 5) cost = Math.max(3, Math.min(6, Math.ceil((m.hp - bonus) / 1.7)));
  cost = Math.max(1, cost - fxv(c, 'missileCost'));
  if (fxv(c, 'necroTax')) cost = Math.ceil(cost * 1.1);
  return cost;
}
// Cast Magic Missile from crawler c at mob m. Can miss; half damage to bosses; may ignite at level 10.
function fireMissile(c, m) {
  const s = c.spells.missile,
    bonus = s.lvl + Math.floor(st(c, 'int') / 4) + fxv(c, 'missile'),
    cost = missileCost(c, m),
    isPet = c === G.pet,
    cls = isPet ? 'pet' : '';
  if (c.mp < cost) return false;
  c.mp -= cost;
  m.awake = true;
  provoke(m);
  G.floorHurt = true;
  G.fx.push({ k: 'bolt', a: { x: c.x, y: c.y }, b: { x: m.x, y: m.y }, t: performance.now() });
  if (!isPet) award('first_spell');
  if (Math.random() * 100 >= Math.max(40, Math.min(95, 70 + st(c, 'dex') * 2 - Math.floor(m.dodge / 2)))) {
    log(`${isPet ? NAMES.pet + '’s' : 'Your'} Magic Missile (${cost} MP) streaks past the ${m.name}.`, cls);
    float(m.x, m.y, 'miss', '#c9a6ff');
    trainSpell(c, 'missile', true);
    return true;
  }
  let d = Math.round((cost * R(14, 20)) / 10) + bonus;
  if (m.boss) d = Math.max(1, Math.round(d / 2));
  m.hp -= d;
  float(m.x, m.y, d, '#c9a6ff');
  let fire = '';
  if (s.lvl >= 10 && Math.random() < 0.3) {
    m.burn = 3;
    m.burnBy = isPet ? 'missile' : 'spell'; // whoever lit the fire gets credit if it finishes the job
    fire = ' It catches fire!';
  }
  log(
    `${isPet ? NAMES.pet + ' casts' : 'You cast'} Magic Missile (${cost} MP) at the ${m.name} for ${d}.${m.boss ? ' Bosses shrug off most of it.' : ''}${fire}`,
    cls,
  );
  if (isPet && Math.random() < 0.25) petSay('missile');
  const dead = m.hp <= 0;
  trainSpell(c, 'missile', true, dead ? 1 : 0);
  if (dead) kill(m, isPet ? 'missile' : 'spell');
  return true;
}
// Neutral mobs turn hostile when attacked, and so does the rest of their crew nearby; attacking breaks a charm
function provoke(m) {
  if (m.ally) return;
  if (m.charmed) {
    m.charmed = false;
    log(`The charm on the ${m.name} breaks. It remembers it hates you.`, 'bad');
  }
  if (!m.hostile) {
    m.hostile = true;
    m.awake = true;
    let n = 0;
    for (const o of G.mobs)
      if (!o.hostile && !o.ally && o !== m && o.fam == m.fam && cheb(o, m) <= 8) {
        o.hostile = true;
        o.awake = true;
        n++;
      }
    log(
      `The ${m.name} is provoked${n ? `, and ${n} of its crew take${n == 1 ? 's' : ''} it personally` : ''}. It’s hostile now.`,
      'bad',
    );
  }
}
// Charisma can override a mob's hostile programming. The crawler with the better odds tries; bosses are immune.
function tryCharm(m) {
  if (m.charmTried || m.boss || !m.hostile || m.ally) return;
  m.charmTried = true;
  const chance = c => Math.max(0, Math.min(70, st(c, 'cha') * 2 - m.level * 6 + fxv(c, 'charm')));
  const c = [G.player, G.pet].filter(c => !c.down && cheb(m, c) <= 6).sort((a, b) => chance(b) - chance(a))[0];
  if (!c) return;
  const ch = chance(c);
  if (!ch) return;
  if (Math.random() * 100 < ch) {
    m.charmed = true;
    m.charmedBy = c === G.pet ? NAMES.pet : NAMES.hero;
    m.awake = false;
    c.charms++;
    log(
      `The ${m.name} gets one look at ${c === G.pet ? NAMES.pet : 'you'} and is <b>charmed</b>. It no longer wants to fight you. (${ch}% chance from ${c === G.pet ? 'her' : 'your'} CHA ${st(c, 'cha')})`,
      c === G.pet ? 'pet' : '',
    );
    addViews(250);
    if (c === G.pet && c.charms >= 2) award('beguiler');
    if (c === G.player) award('charm_hero');
  }
}
const mul = m => (m.anguish > 0 ? 1.5 : 1);
const effArm = m =>
  m.arm + (m.fam == 'goblin' && m.role != 'leader' && G.mobs.some(o => o.role == 'leader' && cheb(o, m) <= 6) ? 1 : 0);
// Vampire Bat lifesteal.
function vampHeal(m, d) {
  if (m.role == 'vamp' && d > 0) {
    const h = Math.ceil(d / 2);
    m.hp = Math.min(m.maxhp, m.hp + h);
    float(m.x, m.y, '+' + h, '#ff6b8b');
  }
}
// damage a crawler from a spell or explosion (safe rooms protect)
function hurt(c, d, cause) {
  if (c.down || tile(c.x, c.y) == SAFE) return;
  c.hp -= d;
  float(c.x, c.y, '-' + d, c === G.player ? '#ff5a6e' : '#ffa5d0');
  if (c === G.player) {
    G.shake = reduced ? 0 : 6;
    if (c.hp <= 0) {
      c.hp = 0;
      die(cause);
    }
  } else if (c.hp <= 0) {
    c.hp = 0;
    c.down = true;
    log(`${NAMES.pet} is knocked out! Rest in a safe room to revive her.`, 'bad');
  }
}
// A monster's 3x3 explosion (bomb or fireball). Hits everyone in range, including the thrower's friends.
function blast(cx, cy, d, src, color) {
  G.fx.push({ k: 'boom', x: cx, y: cy, t: performance.now(), col: color });
  for (const o of G.mobs.slice())
    if (o !== src && Math.abs(o.x - cx) <= 1 && Math.abs(o.y - cy) <= 1 && !shielded(o)) {
      o.hp -= d;
      o.foe = o.fam !== src.fam ? src : o.foe;
      float(o.x, o.y, d, '#ffb347');
      if (o.hp <= 0) kill(o, 'mob', src);
    }
  for (const c of [G.player, G.pet])
    if (!G.over && Math.abs(c.x - cx) <= 1 && Math.abs(c.y - cy) <= 1)
      hurt(c, Math.max(1, d - Math.floor((c.gear.armor.v || 0) / 2)), `Blown up by a ${src.name} on Floor ${G.floor}.`);
}
// Step to the neighbor that increases distance from t (ranged monsters keep their distance).
function stepAway(m, t) {
  let best = null,
    bd = cheb(m, t);
  for (const [dx, dy] of DIRS) {
    const nx = m.x + dx,
      ny = m.y + dy,
      tt = tile(nx, ny);
    if (tt == WALL || tt == SAFE || occupied(nx, ny, m) || (m.room && !inRoom(m.room, nx, ny))) continue;
    const d = Math.max(Math.abs(nx - t.x), Math.abs(ny - t.y));
    if (d > bd) {
      bd = d;
      best = [nx, ny];
    }
  }
  if (best) {
    m.x = best[0];
    m.y = best[1];
    return true;
  }
  return false;
}
const seen = m => G.vis[idx(m.x, m.y)];
const who = t => (t === G.player ? 'you' : t === G.pet ? NAMES.pet : `the ${t.name}`);
const isCrawler = t => t === G.player || t === G.pet;
// Does mob m want to fight mob o? (faction wars, grudges, and Donut's undead minion)
function mobFoe(m, o) {
  if (o === m || o.dead) return false;
  if (m.ally) return !o.ally && o.hostile && !o.charmed;
  if (o.ally) return m.hostile && !m.charmed;
  if (m.foe === o) return true;
  return !!(m.faction && o.faction && FFOES[m.faction] && FFOES[m.faction].includes(o.faction));
}
// Nearest valid target for mob m: a crawler (if m is hostile) or an enemy mob it can see within 8 tiles.
function pickTarget(m) {
  let best = null,
    bd = 99;
  if (m.hostile && !m.charmed && !m.ally)
    for (const c of [G.player, G.pet]) {
      if (c.down || tile(c.x, c.y) == SAFE) continue; // can't be touched in a safe room
      const d = cheb(m, c);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
  for (const o of G.mobs) {
    if (!mobFoe(m, o)) continue;
    const d = cheb(m, o);
    if (d <= 8 && d < bd && los(m.x, m.y, o.x, o.y)) {
      bd = d;
      best = o;
    }
  }
  return best;
}
// Deal damage from mob m to target t, which may be a crawler or another mob.
function strike(m, t, d, cause) {
  if (isCrawler(t)) {
    hurt(t, d, cause);
    return;
  }
  if (shielded(t) || shielded(m)) return;
  t.hp -= d;
  t.foe = m;
  t.awake = true;
  if (seen(t)) float(t.x, t.y, d, '#ffb347');
  if (t.hp <= 0) kill(t, 'mob', m);
}
// Melee between two monsters (faction war, grudges, Donut's minion).
function mobHitMob(a, b) {
  if (Math.random() * 100 >= Math.max(30, 80 - b.dodge)) {
    if (seen(b)) float(b.x, b.y, 'miss', '#a897bb');
    b.foe = a;
    return;
  }
  const d = Math.max(1, Math.round(R(a.lo, a.hi) * mul(a)) - effArm(b));
  vampHeal(a, d);
  if (seen(a) || seen(b)) log(`The ${a.name} hits the ${b.name} for ${d}.`, 'dim');
  strike(a, b, d);
}
// Ranged attack from mob m at t, by role: bomber/fireball (3x3 blast), lunch (poison tray),
// hybrid (hex), spitter (spit).
function rangedAct(m, t) {
  m.cd = m.cdMax;
  const d0 = Math.round(R(m.lo, m.hi) * mul(m)),
    vis = seen(m) || G.vis[idx(t.x, t.y)];
  const cls = isCrawler(t) ? 'bad' : 'dim';
  if (m.role == 'bomber') {
    if (vis) log(`The ${m.name} lights a bomb off its helmet and lobs it at ${who(t)}!`, cls);
    blast(t.x, t.y, d0, m, '#ffb347');
  } else if (m.role == 'fireball') {
    if (vis) log(`The ${m.name} hurls a fireball at ${who(t)}!`, cls);
    blast(t.x, t.y, d0 + 1, m, '#ff6a2a');
  } else if (m.role == 'lunch') {
    G.fx.push({ k: 'bolt', a: { x: m.x, y: m.y }, b: { x: t.x, y: t.y }, t: performance.now(), col: '#c9a36a' });
    const d = Math.max(1, d0 - 2);
    if (vis) log(`${m.name} flings a tray of mystery meat at ${who(t)} for ${d}. It is poisonous, obviously.`, cls);
    strike(m, t, d, `Killed by ${m.name}’s mystery meat on Floor ${G.floor}.`);
    if (isCrawler(t) && !t.down) t.poison = Math.max(t.poison, 3);
  } else if (m.role == 'hybrid') {
    G.fx.push({ k: 'bolt', a: { x: m.x, y: m.y }, b: { x: t.x, y: t.y }, t: performance.now(), col: '#7ee081' });
    const d = Math.max(1, d0 - 1);
    if (vis) log(`The ${m.name} spits a hex at ${who(t)} for ${d}.`, cls);
    strike(m, t, d, `Hexed to death by a ${m.name} on Floor ${G.floor}.`);
  } else if (m.role == 'spitter') {
    G.fx.push({ k: 'bolt', a: { x: m.x, y: m.y }, b: { x: t.x, y: t.y }, t: performance.now(), col: '#e8e2c0' });
    if (vis) log(`The ${m.name} spits a disgusting wad at ${who(t)} for ${d0}.`, cls);
    strike(m, t, d0, `Spat to death by a ${m.name} on Floor ${G.floor}. Humiliating.`);
  }
}
// Goblin Shamanka: Anguish Magic gives a nearby ally +50% damage for 4 turns.
function supportAct(m) {
  if (m.cd > 0) return false;
  const al = G.mobs.filter(
    o =>
      o !== m &&
      !o.charmed &&
      !o.ally &&
      !mobFoe(m, o) &&
      o.awake &&
      o.anguish <= 0 &&
      cheb(o, m) <= m.range &&
      los(m.x, m.y, o.x, o.y),
  );
  if (!al.length) return false;
  const p = G.player,
    o = al.sort((a, b) => cheb(a, p) - cheb(b, p))[0];
  o.anguish = 4;
  m.cd = m.cdMax;
  G.fx.push({ k: 'bolt', a: { x: m.x, y: m.y }, b: { x: o.x, y: o.y }, t: performance.now(), col: '#c77dff' });
  if (seen(m) || seen(o))
    log(`The ${m.name} chants in Anguish. The ${o.name} glows purple: +50% damage for 4 turns.`, 'bad');
  return true;
}
// Breadth-first path step: move m one tile along the shortest walkable route to (tx,ty), searching
// within `lim` tiles. Used by janitors, vacuums, and Donut/her minion following Carl around walls.
// Monsters can't route through safe rooms; crawlers and allies can (canSafe).
function pathStep(m, tx, ty, lim, canSafe) {
  const W = G.W,
    start = idx(m.x, m.y),
    goal = idx(tx, ty);
  if (start == goal) return false;
  const prev = new Map([[start, -1]]),
    q = [start];
  let h = 0,
    found = false;
  while (h < q.length) {
    const i = q[h++];
    if (i == goal) {
      found = true;
      break;
    }
    const x = i % W,
      y = (i / W) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx,
        ny = y + dy;
      if (Math.abs(nx - m.x) > lim || Math.abs(ny - m.y) > lim) continue;
      const t = tile(nx, ny),
        n = idx(nx, ny);
      if (t == WALL || (t == SAFE && !canSafe) || prev.has(n)) continue;
      if (n != goal && occupied(nx, ny, m)) continue;
      prev.set(n, i);
      q.push(n);
    }
  }
  if (!found) return false;
  let c = goal;
  while (prev.get(c) !== start) c = prev.get(c);
  const nx = c % W,
    ny = (c / W) | 0;
  if (occupied(nx, ny, m)) return false;
  m.x = nx;
  m.y = ny;
  return true;
}
// Janitor rat: head for the nearest corpse within 12 tiles and eat it (+1 level each).
// Fights instead if a crawler is right next to it.
function janitorAct(m) {
  const p = G.player,
    pt = G.pet;
  if (m.awake && (cheb(m, p) == 1 || (!pt.down && cheb(m, pt) == 1))) return false;
  let best = null,
    bd = 13;
  for (const c of G.corpses) {
    const d = cheb(c, m);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  if (!best) return false;
  if (bd == 0) {
    G.corpses = G.corpses.filter(c => c !== best);
    m.eaten++;
    m.level++;
    const g = Math.round(m.maxhp * 0.2) + 2;
    m.maxhp += g;
    m.hp += g;
    if (m.eaten % 2 == 0) {
      m.lo++;
      m.hi++;
    }
    m.xp = Math.round(m.xp * 1.25);
    m.sc = Math.min(1.5, (m.sc || 0.8) + 0.08);
    if (seen(m)) log(`The ${m.name} devours the corpse of the ${best.name} and grows to level ${m.level}.`, 'bad');
    return true;
  }
  if (!pathStep(m, best.x, best.y, 18)) stepToward(m, best.x, best.y, false);
  return true;
}
// Vacuum Bot: drive to the nearest loose item and suck it up (dropped again when it dies).
function vacuumAct(m) {
  const p = G.player,
    pt = G.pet;
  if (m.awake && (cheb(m, p) == 1 || (!pt.down && cheb(m, pt) == 1))) return false;
  let best = null,
    bd = 9;
  for (const it of G.items) {
    if (it.k == 'sign' || it.k == 'map' || it.k == 'guide') continue;
    const d = cheb(it, m);
    if (d < bd && tile(it.x, it.y) != SAFE) {
      bd = d;
      best = it;
    }
  }
  if (!best) return false;
  if (bd == 0) {
    G.items = G.items.filter(i => i !== best);
    m.loot.push(best.k);
    if (seen(m))
      log(
        `The ${m.name} vacuums up a ${best.k.startsWith('box_') ? cap(best.k.slice(4)) + ' Box' : best.k}. Rude.`,
        'bad',
      );
    return true;
  }
  if (!pathStep(m, best.x, best.y, 12)) stepToward(m, best.x, best.y, false);
  return true;
}
// One monster's turn: status effects, waking up, role behavior, then attack/approach/retreat its target.
function mobTurn(m) {
  const p = G.player,
    pt = G.pet;
  if (m.burn > 0) {
    m.burn--;
    const d = 2 + G.floor;
    m.hp -= d;
    float(m.x, m.y, d, '#ffb347');
    if (m.hp <= 0) {
      log(`The ${m.name} burns to a crisp.`, 'kill');
      kill(m, m.burnBy || 'missile');
      return;
    }
  }
  if (m.psn > 0) {
    m.psn--;
    const d = 1 + Math.floor(G.floor / 2);
    m.hp -= d;
    float(m.x, m.y, d, '#9be15d');
    if (m.hp <= 0) {
      kill(m, 'spell'); // only Carl's rat-kin bite poisons mobs
      return;
    }
  }
  if (m.ally) {
    if (--m.timer <= 0) {
      m.dead = true;
      G.mobs = G.mobs.filter(o => o !== m);
      if (seen(m)) log(`The ${m.name} crumbles back into the dead.`, 'pet');
      return;
    }
    m.awake = true;
  }
  if (m.anguish > 0) m.anguish--;
  if (m.cd > 0) m.cd--;
  if (shielded(m)) return; // waits behind the barrier until the lair seals
  if (!m.awake && seen(m) && cheb(m, p) <= 7) {
    m.awake = true;
    tryCharm(m);
    if (m.charmed) return;
  }
  if (!m.awake && m.faction && G.mobs.some(o => mobFoe(m, o) && cheb(m, o) <= 6 && los(m.x, m.y, o.x, o.y)))
    m.awake = true;
  if (m.role == 'janitor' && janitorAct(m)) return;
  if (m.role == 'vacuum' && vacuumAct(m)) return;
  if (!m.awake) {
    if (Math.random() < 0.2) randStep(m);
    return;
  }
  const tgt = pickTarget(m);
  if (!tgt) {
    if (m.ally) {
      if (cheb(m, p) > 2 && !pathStep(m, p.x, p.y, 14, true)) stepToward(m, p.x, p.y, true);
    } else if (Math.random() < 0.25) randStep(m);
    return;
  }
  if (m.erratic && Math.random() < 0.35) {
    randStep(m);
    return;
  }
  const d = cheb(m, tgt),
    kite = KITERS[m.role],
    tSafe = tile(tgt.x, tgt.y) == SAFE,
    cr = isCrawler(tgt);
  if (m.role == 'support' && supportAct(m)) return;
  if (m.role == 'slam' && m.cd == 0 && [p, pt].some(c => !c.down && cheb(c, m) == 1 && tile(c.x, c.y) != SAFE)) {
    m.cd = m.cdMax;
    G.shake = reduced ? 0 : 12;
    log(`${m.name} starts its spin cycle! Everything next to it gets rattled.`, 'bad');
    for (const c of [p, pt])
      if (!c.down && cheb(c, m) == 1)
        hurt(
          c,
          Math.max(1, Math.round(R(m.lo, m.hi) * mul(m)) - Math.floor(c.gear.armor.v / 2)),
          `Put through the spin cycle by ${m.name} on Floor ${G.floor}.`,
        );
    return;
  }
  if (m.range && m.role != 'support' && m.cd == 0 && d >= 2 && d <= m.range && !tSafe && los(m.x, m.y, tgt.x, tgt.y)) {
    rangedAct(m, tgt);
    return;
  }
  if (d == 1 && !tSafe) {
    if (kite && Math.random() < 0.6 && stepAway(m, tgt)) return;
    if (cr) mobAttack(m, tgt);
    else mobHitMob(m, tgt);
    return;
  }
  if (cr && cheb(m, tgt) > 14) {
    m.awake = false;
    return;
  }
  if (m.room && !inRoom(m.room, tgt.x, tgt.y) && d > 1) return;
  if (kite && d <= 2 && stepAway(m, tgt)) return;
  if (kite && d <= m.range && los(m.x, m.y, tgt.x, tgt.y)) return; // hold position while reloading
  stepToward(m, tgt.x, tgt.y, !!m.ally);
}
// Every monster acts once; corpses age and eventually disappear.
function mobsAct() {
  for (const m of G.mobs.slice()) {
    if (G.over) return;
    if (!m.dead) mobTurn(m); // a mob killed earlier this turn doesn't act
  }
  for (const c of G.corpses) c.age++;
  G.corpses = G.corpses.filter(c => c.age < 220);
}

// Announce the 300/150/50-turn warnings whenever the countdown crosses one (from `before` down to G.turns).
function announceTimer(before) {
  for (const w of [300, 150, 50])
    if (before > w && G.turns <= w && G.turns > 0)
      ai(`Attention, crawlers: the stairwells on this floor close in ${G.turns} turns.`);
}
// Finish a player turn: Donut, monsters, status ticks, floor timer (collapse at 0), FOV and UI.
function endTurn() {
  if (G.over) return;
  G.petTalk = Math.max(0, G.petTalk - 1);
  petAct();
  mobsAct();
  if (G.over) return;
  tick(G.player);
  if (G.over) return;
  tick(G.pet);
  G.turns--;
  announceTimer(G.turns + 1);
  if (G.turns <= 0) {
    if (tile(G.player.x, G.player.y) == STAIRS) {
      descend();
      return;
    }
    die(`The floor collapsed. You weren't in a stairwell when the timer hit zero.`);
    return;
  }
  fov();
  ui();
}

// =====================================================================================================
// PLAYER ACTIONS
// =====================================================================================================
const busy = () => !G || G.over || !$('#modal').hidden;
// Move Carl one tile, attack whatever is there, or swap with Donut/her minion. Ends the turn.
function move(dx, dy) {
  if (busy()) return;
  const p = G.player;
  if (!dx && !dy) {
    log('You wait a turn.', 'dim');
    endTurn();
    return;
  }
  const nx = p.x + dx,
    ny = p.y + dy,
    m = mobAt(nx, ny);
  if (m) {
    if (m.ally) {
      m.x = p.x;
      m.y = p.y;
      p.x = nx;
      p.y = ny;
      endTurn();
      return;
    }
    if (shielded(m)) {
      log(`A shimmering System barrier fills the lair doorway. You can't touch the ${m.name} until you step inside and the lair seals.`, 'dim');
      return;
    }
    playerAttack(m);
    endTurn();
    return;
  }
  const t = tile(nx, ny);
  if (t == WALL) {
    G.bumps++;
    log('You walk into a wall.', 'dim');
    if (G.bumps >= 5) award('wall');
    ui();
    return;
  }
  // Stepping into a boss lair seals it, so ask first (once per lair).
  const lair = G.lairs.find(
    L => !L.sealed && !L.ok && G.mobs.includes(L.boss) && inRoom(L.room, nx, ny) && !inRoom(L.room, p.x, p.y),
  );
  if (lair) {
    const b = lair.boss,
      gap = b.level - p.lvl;
    modal(
      `<h2>Boss lair ahead</h2><p><b>${b.name}</b>, level ${b.level} ${b.tier} Boss, is waiting inside with ${lair.minions.filter(m => G.mobs.includes(m)).length} minion(s). You are level ${p.lvl}; ${NAMES.pet} is level ${G.pet.lvl}.</p><p class="lvl">Once you step in, the doors seal until the boss is dead.${gap >= 3 ? ' You look badly outmatched. Clearing more of the floor first would help.' : ''}${b.tier == 'Borough' ? ' This boss is optional.' : ''}</p>`,
      [
        { label: 'Not yet', primary: 1 },
        {
          label: 'Enter the lair',
          fn: () => {
            lair.ok = true;
            move(dx, dy);
          },
        },
      ],
    );
    return;
  }
  const pt = G.pet;
  if (!pt.down && pt.x == nx && pt.y == ny) {
    pt.x = p.x;
    pt.y = p.y;
  }
  p.x = nx;
  p.y = ny;
  pickup();
  checkLair();
  if (t == SAFE) {
    if (!G.inSafe) enterSafe();
    G.inSafe = true;
  } else G.inSafe = false;
  if (t == STAIRS) log('You are standing in the stairwell. Press > or Take stairs to go down.', 'guide');
  endTurn();
}
// First step into a safe room: achievement and Mordecai's greeting.
function enterSafe() {
  award('safe');
  if (!G.safeVisited) {
    G.safeVisited = true;
    log(
      `${NAMES.guide}, your game guide, looks up from his table: “Open your boxes, rest if you need it, and keep one eye on that timer.”`,
      'guide',
    );
  } else log('You step into the safe room. The monsters can’t follow you in here.', 'guide');
}
// Pick up everything on Carl's tile: consumables, boxes, the dungeon sign, and boss persistent loot.
function pickup() {
  const p = G.player;
  for (const it of G.items.filter(i => i.x == p.x && i.y == p.y)) {
    if (it.k.startsWith('box_')) {
      const tier = it.k.slice(4);
      G.player.boxes.push(tier + '|Adventurer');
      log(`You pick up a ${cap(tier)} Box. Open it in a safe room.`, 'kill');
    } else if (it.k == 'map') {
      const h = hoodOf(it.x, it.y);
      let n = 0,
        mobs = 0;
      for (let i = 0; i < G.map.length; i++) {
        const x = i % G.W,
          y = (i / G.W) | 0;
        if (hoodOf(x, y) != h) continue;
        if (G.map[i] != WALL || hasFloorNear(i)) {
          if (!G.seen[i]) n++;
          G.seen[i] = 1;
          if (G.map[i] == STAIRS) {
            if (!G.stairsKnown) award('stairs');
            G.stairsKnown = true;
          }
        }
      }
      for (const m of G.mobs)
        if (hoodOf(m.x, m.y) == h) {
          m.scouted = true;
          mobs++;
        }
      G.hoodsMapped.add(h);
      award('nbmap');
      log(
        `You touch the Neighborhood Map. The entire ${HOODN[h]} neighborhood fills in on your map: ${n} new tiles and ${mobs} monsters.`,
        'guide',
      );
      if (G.hud) setMapMode('big'); // show off the newly mapped neighborhood (full view needs the sign upgrade)
    } else if (it.k == 'sign') {
      G.hud = true;
      award('sign');
      log(
        'You read the official dungeon sign. Mostly it’s a list of things you can’t sue anybody for. Your minimap now shows creatures and corpses, and it can expand to the whole floor (M).',
        'guide',
      );
    } else if (it.k == 'guide') {
      let n = 0;
      for (const m of G.mobs)
        if (cheb(m, p) <= 35) {
          m.scouted = true;
          n++;
        }
      log(
        `You loot the Borough Field Guide. It labels ${n} monsters in the surrounding quadrants with their type and level. You can now see them on explored parts of your map.`,
        'guide',
      );
    } else {
      G.player.inv[it.k]++;
      log(`You pick up ${{ potion: 'a healing potion', bomb: 'a bomb' }[it.k]}.`, 'kill');
    }
    G.items = G.items.filter(i => i !== it);
  }
}
// Drink a healing potion. Drinking during the CON-based cooldown still heals but causes potion sickness.
function quaff() {
  if (busy()) return;
  const p = G.player;
  if (!p.inv.potion) {
    log('You have no potions.', 'dim');
    return;
  }
  if (p.hp >= p.maxhp) {
    log('You are already at full health.', 'dim');
    return;
  }
  p.inv.potion--;
  const h = Math.round(p.maxhp * 0.5);
  p.hp = Math.min(p.maxhp, p.hp + h);
  float(p.x, p.y, '+' + h, '#7ef0a0');
  if (p.potCD > 0) {
    p.poison = Math.max(p.poison, 5);
    log(
      `You chug a healing potion (+${h} HP) before your potion cooldown is up. Potion sickness: you are poisoned!`,
      'bad',
    );
    award('impatient');
  } else log(`You drink a healing potion and recover ${h} HP.`);
  p.potCD = potionCD(p);
  endTurn();
}
// Carl's Heal spell (3 MP). Clerics heal more, and heal Donut too. No casting inside safe rooms.
function castHeal() {
  if (busy()) return;
  const p = G.player,
    s = p.spells.heal;
  if (tile(p.x, p.y) == SAFE) {
    log('Most spells can’t be cast inside a safe room. Try resting instead.', 'dim');
    return;
  }
  if (p.mp < 3) {
    log(
      `Not enough mana: Heal costs 3 MP and you have ${p.mp}. With INT ${st(p, 'int')} you regain 1 MP every ${mpEvery(p)} turns.`,
      'dim',
    );
    return;
  }
  const party = fxv(p, 'healParty') && !G.pet.down;
  if (p.hp >= p.maxhp && !(party && G.pet.hp < G.pet.maxhp)) {
    log(party ? 'You and Princess Donut are both at full health.' : 'You are already at full health.', 'dim');
    return;
  }
  p.mp -= 3;
  const h = Math.round((6 + s.lvl * 2 + st(p, 'int')) * (1 + fxv(p, 'healMul')));
  p.hp = Math.min(p.maxhp, p.hp + h);
  float(p.x, p.y, '+' + h, '#7ef0a0');
  const pt = G.pet;
  if (fxv(p, 'healParty') && !pt.down) {
    pt.hp = Math.min(pt.maxhp, pt.hp + h);
    float(pt.x, pt.y, '+' + h, '#7ef0a0');
  }
  const combat = G.mobs.some(m => m.hostile && !m.charmed && G.vis[idx(m.x, m.y)]);
  log(
    `You glow red and cast Heal (3 MP), recovering ${h} HP${fxv(p, 'healParty') && !pt.down ? ` for you and ${NAMES.pet}` : ''}.`,
  );
  award('first_spell');
  trainSpell(p, 'heal', combat);
  endTurn();
}
// Carl's Magic Missile (Mage class) at the nearest visible hostile.
function castMissile() {
  if (busy()) return;
  const p = G.player;
  if (!p.spells.missile) return;
  if (tile(p.x, p.y) == SAFE) {
    log('Most spells can’t be cast inside a safe room.', 'dim');
    return;
  }
  const tg = G.mobs
    .filter(
      m =>
        m.hostile &&
        !m.charmed &&
        !m.ally &&
        !shielded(m) &&
        G.vis[idx(m.x, m.y)] &&
        cheb(m, p) <= 7 &&
        los(p.x, p.y, m.x, m.y),
    )
    .sort((a, b) => cheb(a, p) - cheb(b, p))[0];
  if (!tg) {
    log('No hostile target in sight for Magic Missile.', 'dim');
    return;
  }
  const cost = missileCost(p, tg);
  if (p.mp < cost) {
    log(`Not enough mana: this missile costs ${cost} MP and you have ${p.mp}.`, 'dim');
    return;
  }
  fireMissile(p, tg);
  endTurn();
}
// Throw a bomb at the nearest visible hostile (3x3 blast). Can hurt Carl and Donut unless the class prevents it.
function bomb() {
  if (busy()) return;
  const p = G.player;
  if (!p.inv.bomb) {
    log('You have no bombs.', 'dim');
    return;
  }
  const tg = G.mobs
    .filter(
      m =>
        m.hostile &&
        !m.charmed &&
        !m.ally &&
        !shielded(m) &&
        G.vis[idx(m.x, m.y)] &&
        cheb(m, p) <= 6 &&
        los(p.x, p.y, m.x, m.y),
    )
    .sort((a, b) => cheb(a, p) - cheb(b, p))[0];
  if (!tg) {
    log('No hostile target in range to throw a bomb at.', 'dim');
    return;
  }
  p.inv.bomb--;
  const d = Math.round((R(10, 16) + G.floor * 3) * (1 + fxv(p, 'bombMul'))),
    cx = tg.x,
    cy = tg.y;
  let kills = 0;
  award('boom');
  G.fx.push({ k: 'boom', x: cx, y: cy, t: performance.now() });
  G.shake = reduced ? 0 : 10;
  log(`You light a bomb and lob it at the ${tg.name}. BOOM.`, 'kill');
  for (const m of G.mobs.slice())
    if (Math.abs(m.x - cx) <= 1 && Math.abs(m.y - cy) <= 1 && !shielded(m)) {
      m.hp -= d;
      m.awake = true;
      provoke(m);
      G.floorHurt = true;
      float(m.x, m.y, d, '#ffb347');
      if (m.hp <= 0) {
        kills++;
        kill(m, 'bomb');
      }
    }
  if (fxv(p, 'bombImmune') && Math.abs(p.x - cx) <= 1 && Math.abs(p.y - cy) <= 1)
    log('You’re standing in the blast, but your training means it doesn’t touch you.', 'dim');
  else if (Math.abs(p.x - cx) <= 1 && Math.abs(p.y - cy) <= 1) {
    const s = Math.round(d / 2);
    p.hp -= s;
    float(p.x, p.y, '-' + s, '#ff5a6e');
    log(`You were standing a little too close. You take ${s} damage.`, 'bad');
    if (p.hp <= 0) {
      p.hp = 0;
      die('Blown up by your own bomb. The audience will be replaying that one for years.');
      return;
    }
  }
  const pt = G.pet;
  if (!pt.down && Math.abs(pt.x - cx) <= 1 && Math.abs(pt.y - cy) <= 1) {
    pt.hp = Math.max(0, pt.hp - Math.round(d / 2));
    log(`${NAMES.pet} gets singed. She will not forget this.`, 'pet');
    if (!pt.hp) {
      pt.down = true;
      log(`${NAMES.pet} is knocked out!`, 'bad');
    }
  }
  addViews(200 + kills * 300);
  if (kills >= 4) award('crowd');
  endTurn();
}
// Does a wall tile border any open tile? (Used to reveal only meaningful walls on maps.)
function hasFloorNear(i) {
  const x = i % G.W,
    y = (i / G.W) | 0;
  return DIRS.some(([dx, dy]) => tile(x + dx, y + dy) != WALL);
}
// Rest in a safe room: full heal for both, revive Donut, costs 40 turns of the floor timer.
function rest() {
  if (busy()) return;
  const p = G.player,
    pt = G.pet;
  if (tile(p.x, p.y) != SAFE) {
    log('You can only rest inside a safe room.', 'dim');
    return;
  }
  if (p.hp >= p.maxhp && !pt.down && pt.hp >= pt.maxhp) {
    log('You are already fully rested.', 'dim');
    return;
  }
  const before = G.turns;
  G.turns -= 40;
  announceTimer(before);
  recalc(p);
  recalc(pt);
  for (const c of [p, pt]) {
    c.hp = c.maxhp;
    c.mp = c.maxmp;
    c.poison = 0;
    c.potCD = 0;
  }
  if (pt.down) {
    pt.down = false;
    const s = DIRS.map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy })).find(
      s => tile(s.x, s.y) != WALL && !occupied(s.x, s.y, pt),
    );
    if (s) {
      pt.x = s.x;
      pt.y = s.y;
    }
    log(`${NAMES.pet} wakes up, furious and fabulous.`, 'pet');
  }
  log('You rest for 40 turns. Fully healed.', 'guide');
  if (G.turns <= 0) {
    die('You slept through the timer. The floor collapsed around you.');
    return;
  }
  fov();
  ui();
}
// Roll a gear piece for crawler c. boost raises the quality index (0-4, or 5 for Celestial-level boosts).
function gearRoll(c, boost, slot) {
  const top = boost >= 4 ? 5 : 4,
    lv = Math.min(top, Math.max(0, G.floor - 1 + boost + R(0, 1)));
  slot = slot || pick(['weapon', 'armor', 'charm']);
  const [n, v] = LOOT[c.race][slot][lv];
  return { slot, n, v, t: lv };
}
// What each box type holds. Tier sets how many items and how good the gear is.
function rollBox(c, box) {
  const tier = boxTier(box),
    type = boxType(box) || 'Adventurer',
    ti = TIER_ORDER[tier] ?? 0,
    tb = TB[tier] ?? 0,
    out = [],
    nC = [1, 2, 2, 3, 3, 4][ti],
    cons = () => pick(LOOT[c.race].cons);
  const slotFor = { Weapon: 'weapon', Apparel: 'armor', 'Magic Item': 'charm', Beguiler: 'charm' }[type];
  if (type == 'Survivor’s') {
    for (let i = 0; i <= nC; i++) out.push(c.race == 'cat' ? 'kibble' : 'potion');
    return out;
  }
  if (type == 'Goblin' || type == 'Crowd Control') {
    for (let i = 0; i < nC + 2; i++) out.push(c.race == 'cat' ? 'kibble' : 'bomb');
    if (type == 'Crowd Control') out.push(gearRoll(c, tb));
    return out;
  }
  if (slotFor) {
    out.push(gearRoll(c, tb + 1, slotFor));
    if (c.race == 'cat' && type == 'Magic Item') out.push('tome');
    for (let i = 1; i < nC; i++) out.push(cons());
    return out;
  }
  if (type == 'Benefactor') {
    out.push(gearRoll(c, tb + 2));
    if (ti >= 2) out.push(gearRoll(c, tb + 2));
    for (let i = 0; i < nC; i++) out.push(cons());
    return out;
  }
  if (type == 'Boss') {
    out.push(gearRoll(c, tb + 1));
    for (let i = 0; i < nC; i++) out.push(cons());
    return out;
  }
  if (type == 'Pet') {
    out.push(gearRoll(c, tb + 1));
    for (let i = 0; i < nC; i++) out.push(cons());
    return out;
  }
  for (let i = 0; i < nC; i++) out.push(cons());
  if (Math.random() < [0.15, 0.4, 0.8, 1, 1, 1][ti]) out.push(gearRoll(c, tb));
  if (ti == 4 && Math.random() < 0.5) out.push(gearRoll(c, tb));
  if (ti == 5) out.push(gearRoll(c, tb));
  if (G.player.raceKey == 'hobgoblin' && c === G.player) out.push('bomb'); // hobgoblin loot leans explosive
  return out;
}
const bonusTxt = (slot, v) =>
  slot == 'charm'
    ? Object.entries(v)
        .map(([k, x]) => `+${x}${k == 'crit' ? '% crit' : ' ' + STATN[k]}`)
        .join(', ')
    : `+${v} ${slot == 'weapon' ? 'attack' : 'armor'}`;
// Give one loot item to crawler c: consumables go to inventory, tomes apply immediately,
// gear auto-equips if it's a higher tier than what's worn. Returns a description for the unboxing screen.
function applyLoot(c, it) {
  if (typeof it == 'string') {
    if (it == 'tome') {
      c.int++;
      recalc(c);
      return `<b>Tome of Arcane Sass</b>. ${c.name} reads it on the spot: +1 INT`;
    }
    c.inv[it]++;
    return CONSN[it];
  }
  const cur = c.gear[it.slot],
    label = SLOTN[c.race][it.slot];
  if (!cur || it.t > cur.t) {
    const before = c.maxhp;
    c.gear[it.slot] = { n: it.n, v: it.v, t: it.t };
    recalc(c);
    if (c.maxhp > before) c.hp += c.maxhp - before;
    if (c === G.player) {
      award('loot_wear');
      if (it.slot == 'charm') award('magic_gear');
    }
    return `<b>${it.n}</b> (${label}: ${bonusTxt(it.slot, it.v)}), equipped`;
  }
  return `${it.n} (${label}), no better than the ${cur.n}, so it goes in the trash`;
}
const boxCount = () => G.player.boxes.length + G.pet.boxes.length;
// Open every box (safe rooms only), lowest tier first. Pet Boxes deliver their contents to Donut.
function openBoxes() {
  if (busy()) return;
  if (!boxCount()) {
    log('Nobody has any loot boxes.', 'dim');
    return;
  }
  if (tile(G.player.x, G.player.y) != SAFE) {
    log('Loot boxes can only be opened inside a safe room.', 'dim');
    return;
  }
  let html = '<h2>Unboxing time</h2>';
  for (const c of [G.player, G.pet]) {
    if (!c.boxes.length) continue;
    const bx = c.boxes.splice(0).sort((a, b) => TIER_ORDER[boxTier(a)] - TIER_ORDER[boxTier(b)]);
    html +=
      `<h3 style="margin:14px 0 6px">${c === G.player ? 'Your boxes' : c.name + "'s boxes"} <span class="lvl">(loot is keyed to race: ${c === G.player ? RACES[c.raceKey || 'human'].name : 'Cat'})</span></h3>` +
      bx
        .map(t => {
          const tgt = boxType(t) == 'Pet' ? G.pet : c;
          return `<div class="sub" style="color:${TIERC[boxTier(t)]}">${boxLabel(t)}${tgt !== c ? ` <span class="lvl">(pet gear, goes to ${tgt.name})</span>` : ''}</div><ul>${rollBox(
            tgt,
            t,
          )
            .map(i => `<li>${applyLoot(tgt, i)}</li>`)
            .join('')}</ul>`;
        })
        .join('');
  }
  award('open_box');
  petSay('box', true);
  modal(html, [{ label: 'Back to the dungeon', primary: 1 }]);
  ui();
}
// Player pressed 'take stairs'.
function descendAct() {
  if (busy()) return;
  if (sealedLair()) {
    log('The stairwell is sealed until the boss is dead. No running from boss fights on the early floors.', 'dim');
    return;
  }
  if (tile(G.player.x, G.player.y) != STAIRS) {
    log(
      G.stairsKnown ? 'You need to be standing in the stairwell first.' : 'You haven’t found a stairwell yet.',
      'dim',
    );
    return;
  }
  descend();
}
// Floor cleared: summary screen, then build the next floor and award floor-exit achievements.
function descend() {
  const close = G.turns < 60,
    f = G.floor;
  modal(
    `<h2>Floor ${f} cleared</h2><p>You made it into the stairwell with ${Math.max(0, G.turns)} turns to spare.</p><ul><li>Kills this floor: ${G.floorKills}</li><li>New views this floor: ${fmt(G.views - G.floorViews)}</li><li>Followers: ${fmt(followers())}</li></ul><p>Floor ${f + 1} is bigger and meaner, with a longer timer.</p>`,
    [
      {
        label: `Descend to Floor ${f + 1}`,
        primary: 1,
        fn: () => {
          const calm = !G.floorHurt,
            pt = G.pet;
          if (pt.down) {
            pt.down = false;
            pt.hp = Math.round(pt.maxhp / 2);
          }
          newFloor(f + 1);
          award('descend');
          if (close) award('close');
          if (calm) award('pacifist');
          if (!G.pet.hp) G.pet.hp = 1;
          log(
            G.pet.hp < G.pet.maxhp
              ? `${NAMES.pet} limps down the stairs after you, complaining loudly.`
              : `${NAMES.pet} sashays down the stairs behind you.`,
            'pet',
          );
        },
      },
    ],
  );
}
// Game over (only once). Clears any queued dialogs and shows the death screen.
function die(cause) {
  if (G.over) return;
  G.over = true;
  modalQueue.length = 0; // nothing else matters now
  ui();
  modal(
    `<h2>You died</h2><p>${cause}</p><ul><li>Reached Floor ${G.floor}, level ${G.player.lvl}</li><li>Kills: ${G.kills}</li><li>Views: ${fmt(G.views)} · Followers: ${fmt(followers())}</li><li>Achievements: ${G.ach.size}</li></ul><p>The audience gives you a polite round of applause, then changes the channel.</p>`,
    [{ label: 'Crawl again', primary: 1, fn: newGame }],
    { force: true, noEsc: true },
  );
}
// Spend one of Carl's free stat points (after race/class selection).
function spend(c, stat) {
  if (c === G.pet || !c.pts || G.over) return;
  if (stat == 'cha' && fxv(c, 'chaCap') && c.cha + cb(c, 'cha') >= fxv(c, 'chaCap')) {
    log(`Hobgoblin Charisma is capped at ${fxv(c, 'chaCap')}. That point would be wasted.`, 'dim');
    return;
  }
  c[stat]++;
  c.pts--;
  const hp0 = c.maxhp;
  recalc(c);
  if (c.maxhp > hp0) c.hp += c.maxhp - hp0;
  ui();
}

// =====================================================================================================
// MODAL
// =====================================================================================================
// One modal is visible at a time. Anything raised while another is open waits in a queue,
// so a WINNER screen or level-up notice is never silently replaced. opts.force shows it immediately
// (death, and steps of the race/class flow); opts.noEsc stops Escape from pressing the button.
const modalQueue = [];
function modal(html, btns, opts = {}) {
  if (!$('#modal').hidden && !opts.force) {
    modalQueue.push([html, btns, opts]);
    return;
  }
  showModal(html, btns, opts);
}
function showModal(html, btns, opts) {
  const m = $('#modal'),
    c = $('#mcard');
  c.className = 'mcard';
  c.dataset.noesc = opts.noEsc ? '1' : '';
  c.innerHTML =
    html +
    `<div class="mbtns">${btns.map((b, i) => `<button class="mbtn${b.primary ? ' primary' : ''}" data-i="${i}">${b.label}</button>`).join('')}</div>`;
  m.hidden = false;
  c.querySelectorAll('.mbtn').forEach(
    el =>
      (el.onclick = () => {
        m.hidden = true;
        const b = btns[+el.dataset.i];
        if (b.fn) b.fn();
        // show the next queued modal, unless the button's action already opened one
        if (m.hidden && modalQueue.length) showModal(...modalQueue.shift());
        ui();
      }),
  );
  c.querySelector('.mbtn').focus();
}
// =====================================================================================================
// RACE AND CLASS SELECTION (THIRD FLOOR)
// =====================================================================================================
const statTxt = (o, plain) =>
  Object.entries(o)
    .map(([k, v]) => (plain ? `${k.toUpperCase()} ${v}` : `${v > 0 ? '+' : ''}${v} ${k.toUpperCase()}`))
    .join(', ');
// Option-card dialog used by the race/class flow. Grayed-out options show the reason they're locked.
function selModal(title, intro, opts, onPick) {
  const m = $('#modal'),
    c = $('#mcard');
  c.className = 'mcard wide';
  c.dataset.noesc = '1';
  c.innerHTML = `<div class="sub">Third Floor · Race and class selection</div><h2>${title}</h2>${intro}<div class="opts">${opts.map((o, i) => `<button class="opt" data-i="${i}" ${o.ok ? '' : 'disabled'}><b>${o.name}</b>${o.sub ? `<span class="osub">${o.sub}</span>` : ''}<span class="d">${o.desc}</span>${o.why ? `<em>${o.why}</em>` : ''}</button>`).join('')}</div>`;
  m.hidden = false;
  c.querySelectorAll('.opt').forEach(
    el =>
      (el.onclick = () => {
        if (!el.disabled) onPick(opts[+el.dataset.i]);
      }),
  );
  const f = c.querySelector('.opt:not([disabled])');
  if (f) f.focus();
}
const needFor = (c, cl) => Object.entries(cl.min).reduce((a, [k, v]) => a + Math.max(0, v - c[k]), 0);
// Third Floor: step 1, Carl's race.
function startSelection() {
  const p = G.player;
  ai(
    'Welcome to the Third Floor, crawlers. It is time to choose a race and a class. Choose carefully: there are no refunds.',
  );
  const opts = Object.entries(RACES).map(([k, r]) => {
    const ok = !r.req || r.req();
    return {
      key: k,
      name: r.name,
      sub: statTxt(r.mods) || 'No stat changes',
      desc: r.desc,
      ok,
      why: ok ? '' : r.reqTxt,
    };
  });
  selModal(
    `Choose ${NAMES.hero}’s race`,
    `<p>You have <b>${p.bank}</b> banked stat points. Once you pick a class, they automatically cover its minimum stats, and whatever is left is yours to assign.</p>`,
    opts,
    o => {
      p.raceKey = o.key;
      for (const [k, v] of Object.entries(RACES[o.key].mods)) p[k] = Math.max(1, p[k] + v);
      recalc(p);
      ui();
      chooseClass();
    },
  );
}
// Step 2, Carl's class. Banked points must cover the class minimums.
function chooseClass() {
  const p = G.player;
  const opts = Object.entries(CLASSES)
    .filter(([, c]) => c.who == 'hero')
    .map(([k, c]) => {
      const need = needFor(p, c),
        rq = !c.req || c.req(),
        ok = rq && need <= p.bank;
      return {
        key: k,
        name: c.name,
        sub: `${c.type} · minimum ${statTxt(c.min, true)}`,
        desc: c.desc,
        ok,
        why: !rq
          ? c.reqTxt
          : need > p.bank
            ? `Needs ${need} banked points to reach its minimums; you have ${p.bank}.`
            : need
              ? `Uses ${need} of your ${p.bank} banked points.`
              : '',
      };
    });
  selModal(
    `Choose ${NAMES.hero}’s class`,
    `<p>Race: <b>${RACES[p.raceKey].name}</b>. Banked points: <b>${p.bank}</b>. Classes you don’t meet the requirements for are grayed out.</p>`,
    opts,
    o => {
      applyClass(p, o.key);
      choosePetClass();
    },
  );
}
// Apply a class: raise stats to its minimums (Carl pays from banked points), move leftover points to
// assignable points, learn class spells and run any on-pick bonus.
function applyClass(c, key) {
  const cl = CLASSES[key];
  c.cls = key;
  for (const [k, v] of Object.entries(cl.min)) {
    const add = Math.max(0, v - c[k]);
    if (add) {
      c[k] += add;
      if (c === G.player) c.bank -= add;
    }
  }
  if (c === G.player) {
    c.pts += c.bank;
    c.bank = 0;
  }
  if (cl.learn == 'missile' && !c.spells.missile) c.spells.missile = { lvl: 1, xp: 0 };
  if (cl.learn == 'second') c.spells.second = { lvl: 1, xp: 0 };
  if (cl.onPick) cl.onPick(c);
  const h0 = c.maxhp;
  recalc(c);
  if (c.maxhp > h0) c.hp += c.maxhp - h0;
  c.mp = c.maxmp;
}
// Step 3: Donut keeps the Cat race (book stat changes applied once) and picks a class.
function choosePetClass() {
  const pt = G.pet;
  if (!pt.raceDone) {
    pt.raceDone = 1;
    for (const [k, v] of Object.entries(CAT_RACE.mods)) pt[k] = Math.max(1, pt[k] + v);
    recalc(pt);
  }
  const opts = Object.entries(CLASSES)
    .filter(([, c]) => c.who == 'pet')
    .map(([k, c]) => {
      const need = needFor(pt, c),
        rq = !c.req || c.req(),
        ok = rq && !need;
      return {
        key: k,
        name: c.name,
        sub: `${c.type} · minimum ${statTxt(c.min, true)}`,
        desc: c.desc,
        ok,
        why: !rq
          ? c.reqTxt
          : need
            ? `Her stats are ${need} point${need > 1 ? 's' : ''} short of the minimums. Enhanced Growth means she can’t assign points.`
            : '',
      };
    });
  selModal(
    `Choose ${NAMES.pet}’s class`,
    `<p>${NAMES.pet} stays a <b>Cat</b>, as in the books, which costs 3 STR but adds 4 DEX, 2 CON and 1 CHA (already applied). She would never consider anything else.</p>`,
    opts,
    o => {
      applyClass(pt, o.key);
      finishSelection();
    },
  );
}
// Step 4: summary.
function finishSelection() {
  G.chosen = true;
  $('#modal').hidden = true; // close the selection screen before showing the summary
  const p = G.player,
    pt = G.pet;
  modal(
    `<h2>Choices locked in</h2><p><b>${NAMES.hero}</b>: ${RACES[p.raceKey].name} ${CLASSES[p.cls].name}. ${CLASSES[p.cls].desc}</p><p><b>${NAMES.pet}</b>: Cat ${CLASSES[pt.cls].name}. ${CLASSES[pt.cls].desc}</p>${p.pts ? `<p>You have <b>${p.pts}</b> stat points left to assign with the + buttons on your sheet.</p>` : ''}`,
    [{ label: 'Back to the crawl', primary: 1 }],
  );
  log(
    `${NAMES.guide}: “${pick(['Interesting choices. Let’s see if they keep you alive.', 'The audience is going to love this. Or riot. Either way: views.'])}”`,
    'guide',
  );
  ui();
}
// How-to-play dialog.
function help() {
  modal(
    `<h2>Welcome, crawler</h2><p>The surface is gone. What's left of humanity is being herded through a dungeon for the galaxy's most popular reality show. You're ${NAMES.hero}. Your companion, ${NAMES.pet}, is along for the ride.</p>
<ul><li><b>Find the stairwell</b> (glowing cyan steps) before the timer hits zero, or the floor collapses on you.</li><li><b>Bosses.</b> Every floor has a Neighborhood Boss and a tougher, optional Borough Boss that guards a second stairwell. Lairs are dead-end side rooms, never on the route to the stairwell, so you can clear the rest of the floor and level up first. Step into one and the game asks before the doors seal you in until the boss is dead. Each crawler gets a Boss Box and a star, the boss drops a map or field guide, and finishing a boss fight under 10% HP earns a Survivor’s Box.</li><li><b>Map.</b> Read the official dungeon sign near the start to upgrade your basic minimap. It shows what you’ve explored. Safe rooms always appear on it, even under fog of war, but stairwells don’t until you’ve seen them. Press M (or click the map) to cycle it: small, full floor with its four neighborhoods, then off. A boss’s Neighborhood Map fills in its entire neighborhood, monsters included. Hover over a dot on the map (or long-press it on a touchscreen) to see its info card.</li><li><b>Safe rooms</b> (warm amber floors) keep monsters out. Rest and open loot boxes there.</li><li><b>Achievements and loot boxes.</b> Most achievements are the real Floor 1 ones from the books. Boxes come in six tiers (Bronze, Silver, Gold, Platinum, Legendary, Celestial) and many types: Weapon, Apparel, Goblin (explosives), Magic Item, Pet (gear for Donut), Survivor’s, Boss, and Benefactor Boxes from patrons, which hold the rarest gear. Your first kill unlocks experience.</li><li><b>Neutral monsters and factions.</b> Monsters with a white ring (white on the minimap) are neutral. They ignore you until you attack them, and then their whole crew turns on you. Bad Llamas and goblins are at war and fight on sight. Your highest-Charisma crawler can charm hostile monsters.</li><li><b>Race and class.</b> On Floor 3 you pick a race and class for Carl, and a class for Donut. Banked points cover the class’s minimum stats first, and some classes need achievements to unlock (Bomb Squad Tech needs Boom!).</li><li>Walk into a monster to attack it. ${NAMES.pet} fights on her own: she scratches, fires Magic Missile, eats kibble when hurt, and her Charisma can <b>charm</b> monsters so they stop fighting.</li><li><b>Five stats.</b> STR is melee damage. INT sets your mana pool (MP ≈ INT) and how fast it refills. CON sets HP and your potion cooldown, and drinking a potion before the cooldown ends poisons you. DEX is accuracy, dodging and crits. CHA is charm.</li><li><b>Spells cost mana and level up with use</b>, faster in real fights. Magic Missile costs 5 MP; at level 5 she picks 3–6 MP per shot, and at level 10 it can set things on fire. Missiles can miss and do half damage to bosses. No spellcasting inside safe rooms. You start with Heal (3 MP, key C).</li><li><b>Leveling.</b> Each of you earns your own XP (full XP for the killer, a 25% share for the partner). ${NAMES.pet}’s Enhanced Growth automatically gives her +1 STR, +1 INT and +2 CHA per level. Your 3 points per level are banked until race and class selection on Floor 3.</li><li><b>Loot depends on race.</b> Your boxes hold human gear (weapons, armor, charms, potions, bombs). Hers hold cat gear (claws, collars, charms, kibble, spell tomes).</li></ul>
<div class="keys"><kbd>Arrows / WASD / HJKL</kbd><span>Move or attack (YUBN or numpad for diagonals)</span><kbd>. or 5</kbd><span>Wait a turn</span><kbd>Q</kbd><span>Drink a potion (watch the cooldown)</span><kbd>C</kbd><span>Cast Heal</span><kbd>F</kbd><span>Cast Magic Missile (if your class has it)</span><kbd>T</kbd><span>Throw a bomb at the nearest visible enemy</span><kbd>M</kbd><span>Cycle the map: small, full floor, off</span><kbd>R</kbd><span>Rest (safe room, costs 40 turns)</span><kbd>O</kbd><span>Open loot boxes (safe room)</span><kbd>&gt;</kbd><span>Take the stairs</span></div>
<p>On a touchscreen, tap the map to step toward that spot, or use the pad.</p>`,
    [{ label: 'Enter the dungeon', primary: 1 }],
  );
}

// =====================================================================================================
// UI
// =====================================================================================================
function ui() {
  if (!G) return;
  needsDraw = true; // state changed: repaint the map and minimap on the next frame
  const p = G.player,
    pt = G.pet;
  queueMicrotask(() => refreshTip());
  $('#title').textContent = `Dungeon Crawl · Floor ${G.floor}`;
  $('#views').textContent = fmt(G.views);
  $('#fols').textContent = fmt(followers());
  $('#kills').textContent = G.kills;
  $('#timer').textContent = `${Math.max(0, G.turns)} turns`;
  const warn = G.turns <= 150;
  $('#timerChip').classList.toggle('warn', warn);
  $('#fig').classList.toggle('danger', warn);
  setHTML($('#hName'), NAMES.hero + starsHtml(p));
  setHTML(
    $('#hLvl'),
    `${RACES[p.raceKey || 'human'].name}${p.cls ? ' · ' + CLASSES[p.cls].name : ''} · Level ${p.lvl}` +
      (p.poison ? '<span class="status psn">Poisoned</span>' : ''),
  );
  $('#hpBar').style.width = Math.max(0, (p.hp / p.maxhp) * 100) + '%';
  $('#hpTxt').textContent = `${Math.max(0, p.hp)} / ${p.maxhp}`;
  $('#xpBar').style.width = (p.xp / p.next) * 100 + '%';
  $('#xpTxt').textContent = `${p.xp} / ${p.next}`;
  sheet(p, 'h', ['str', 'int', 'con', 'dex', 'cha']);
  $('#hmpBar').style.width = (p.maxmp ? (p.mp / p.maxmp) * 100 : 0) + '%';
  $('#hmpTxt').textContent = `${p.mp} / ${p.maxmp}`;
  setHTML($('#pName'), NAMES.pet + starsHtml(pt));
  setHTML(
    $('#pLvl'),
    `Cat${pt.cls ? ' · ' + CLASSES[pt.cls].name : ''} · Level ${pt.lvl}` +
      (pt.down
        ? '<span class="status ko">Knocked out</span>'
        : pt.poison
          ? '<span class="status psn">Poisoned</span>'
          : ''),
  );
  $('#pBar').style.width = (pt.hp / pt.maxhp) * 100 + '%';
  $('#pTxt').textContent = `${pt.hp} / ${pt.maxhp}`;
  $('#pxBar').style.width = (pt.xp / pt.next) * 100 + '%';
  $('#pxTxt').textContent = `${pt.xp} / ${pt.next}`;
  sheet(pt, 'p', ['str', 'int', 'con', 'dex', 'cha']);
  $('#pmpBar').style.width = (pt.maxmp ? (pt.mp / pt.maxmp) * 100 : 0) + '%';
  $('#pmpTxt').textContent = `${pt.mp} / ${pt.maxmp}`;
  $('#cPot').textContent = '×' + p.inv.potion;
  $('#cBomb').textContent = '×' + p.inv.bomb;
  $('#cMap').textContent = { small: 'small', big: 'full', off: 'off' }[mapMode];
  $('#cBox').textContent = '×' + boxCount();
  $('#cHeal').textContent = '3 MP';
  $('#bMis').hidden = !p.spells.missile;
  if (p.spells.missile) $('#cMis').textContent = (p.spells.missile.lvl < 5 ? 5 : '3–6') + ' MP';
  const here = tile(p.x, p.y),
    misMin = p.spells.missile && p.spells.missile.lvl < 5 ? 5 : 3, // cheapest cast at the current spell level
    healParty = fxv(p, 'healParty') && !pt.down && pt.hp < pt.maxhp,
    dis = {
      missile: !p.spells.missile || here == SAFE || p.mp < misMin,
      heal: p.mp < 3 || here == SAFE || (p.hp >= p.maxhp && !healParty),
      quaff: !p.inv.potion,
      bomb: !p.inv.bomb,
      rest: here != SAFE,
      open: here != SAFE || !boxCount(),
      descend: here != STAIRS,
    };
  document.querySelectorAll('.acts button').forEach(b => (b.disabled = G.over || dis[b.dataset.act]));
}
// one character sheet: stats with + buttons, gear, extras, boxes
const starsHtml = c => {
  const s = c.stars || {};
  return s.bronze || s.silver
    ? ` <span class="stars">${'<i style="color:#cd7f32">★</i>'.repeat(s.bronze || 0)}${'<i style="color:#c3cad6">★</i>'.repeat(s.silver || 0)}</span>`
    : '';
};
// One crawler's character sheet: stats (+ buttons), class, gear, spells, potions, unopened boxes.
function sheet(c, pre, stats) {
  const who = c === G.pet ? 'pet' : 'hero',
    SN = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', cha: 'charisma' };
  setHTML(
    $('#' + pre + 'Stats'),
    stats
      .map(k => {
        const b = cb(c, k);
        const capped = k == 'cha' && fxv(c, 'chaCap') ? `<small> (cap ${fxv(c, 'chaCap')})</small>` : '';
        return `<div><span>${k.toUpperCase()}</span><b>${c[k]}${b ? `<small> +${b}</small>` : ''}${capped}</b>${c.pts && !G.over && who == 'hero' ? `<button class="plus" data-who="${who}" data-stat="${k}" aria-label="Add a point to ${SN[k]}">+</button>` : ''}</div>`;
      })
      .join(''),
  );
  $('#' + (pre == 'h' ? 'pts' : 'pPts')).textContent =
    who == 'pet'
      ? 'Enhanced Growth: +1 STR, +1 INT, +2 CHA every level, assigned automatically.'
      : c.pts
        ? `${c.pts} stat point${c.pts > 1 ? 's' : ''} to assign`
        : c.bank
          ? `${c.bank} points banked. They’re applied when you choose a race and class on Floor 3.`
          : '';
  const g = c.gear,
    row = slot =>
      `<dt>${SLOTN[c.race][slot]}</dt><dd>${g[slot] ? `${g[slot].n}${g[slot].t >= 0 ? ` <span class="lvl">(${bonusTxt(slot, g[slot].v)})</span>` : ''}` : '<span class="lvl">None</span>'}</dd>`;
  const spells = Object.entries(c.spells)
    .map(
      ([k, sp]) =>
        `<dt>${SPELLS[k].name}</dt><dd>Level ${sp.lvl} <span class="lvl">(${SPELLS[k].cost(sp)} MP · ${sp.lvl >= spellCap(c) ? 'maxed' : `${sp.xp}/${spellNext(sp.lvl)} to next`})</span></dd>`,
    )
    .join('');
  const clsRow = c.cls
    ? `<dt>Class</dt><dd>${CLASSES[c.cls].name} <span class="lvl">(${CLASSES[c.cls].type})</span></dd>`
    : '';
  const pot = `<dt>${c === G.pet ? 'Kibble' : 'Potions'}</dt><dd>${c === G.pet ? '×' + c.inv.kibble + ' · ' : ''}${c.potCD ? `Cooldown ${c.potCD} turns` : 'Ready'} <span class="lvl">(${potionCD(c)}-turn cooldown from CON)</span></dd>`;
  const mana = `<dt>Mana</dt><dd>+1 MP every ${mpEvery(c)} turns <span class="lvl">(from INT)</span></dd>`;
  let extra = spells + mana + pot;
  if (c.charms || c === G.pet) extra += `<dt>Charmed</dt><dd>${c.charms} mob${c.charms == 1 ? '' : 's'}</dd>`;
  if (c === G.player && c.bombKills) extra += `<dt>Bomb kills</dt><dd>${c.bombKills}</dd>`;
  setHTML($('#' + pre + 'Gear'), clsRow + row('weapon') + row('armor') + row('charm') + extra);
  const cnt = {};
  c.boxes.forEach(t => (cnt[t] = (cnt[t] || 0) + 1));
  setHTML(
    $('#' + pre + 'Boxes'),
    c.boxes.length
      ? Object.entries(cnt)
          .map(
            ([t, n]) =>
              `<span style="background:${TIERC[boxTier(t)]};color:${TIER_ORDER[boxTier(t)] >= 4 ? '#fff' : '#1a0f00'}">${boxLabel(t)} ×${n}</span>`,
          )
          .join('')
      : '<span class="none">No unopened boxes</span>',
  );
}

// =====================================================================================================
// RENDERING
// =====================================================================================================
const fig = $('#fig'),
  cv = $('#cv'),
  cx = cv.getContext('2d');
let TS = 32,
  dpr = 1,
  needsDraw = true; // set whenever game state changes; draw() skips frames when nothing moves
const ro = new ResizeObserver(() => {
  const r = fig.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  TS = r.width < 560 ? 26 : 32;
  needsDraw = true;
});
ro.observe(fig);
// Paint the map: tiles (dimmed when remembered but not visible), corpses, items, monsters with markers,
// crawlers, torchlight vignette, then short-lived effects. Runs every animation frame but returns early
// when nothing changed.
function draw(now) {
  requestAnimationFrame(draw);
  flushLog();
  if (!G || !cv.width) return;
  const W = cv.width / dpr,
    H = cv.height / dpr;
  const cols = W / TS,
    rows = H / TS,
    p = G.player;
  let tx = G.W <= cols ? (G.W - cols) / 2 : Math.max(0, Math.min(G.W - cols, p.x + 0.5 - cols / 2));
  let ty = G.H <= rows ? (G.H - rows) / 2 : Math.max(0, Math.min(G.H - rows, p.y + 0.5 - rows / 2));
  // Skip the frame entirely when nothing changed and nothing is animating (saves battery on tablets).
  const moving = G.camX == null || Math.abs(tx - G.camX) > 0.01 || Math.abs(ty - G.camY) > 0.01;
  if (!needsDraw && !moving && !G.fx.length && !G.shake) return;
  const fresh = needsDraw;
  needsDraw = false;
  // (clear only once we know we're repainting; a skipped frame must leave the last picture on screen)
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx.fillStyle = '#0d0912';
  cx.fillRect(0, 0, W, H);
  if (G.camX == null || reduced) {
    G.camX = tx;
    G.camY = ty;
  } else {
    G.camX += (tx - G.camX) * 0.2;
    G.camY += (ty - G.camY) * 0.2;
  }
  let ox = 0,
    oy = 0;
  if (G.shake > 0) {
    ox = (Math.random() - 0.5) * G.shake;
    oy = (Math.random() - 0.5) * G.shake;
    G.shake *= 0.85;
    if (G.shake < 0.5) G.shake = 0;
  }
  const sx = x => (x - G.camX) * TS + ox,
    sy = y => (y - G.camY) * TS + oy;
  const x0 = Math.max(0, Math.floor(G.camX)),
    y0 = Math.max(0, Math.floor(G.camY)),
    x1 = Math.min(G.W - 1, Math.ceil(G.camX + cols)),
    y1 = Math.min(G.H - 1, Math.ceil(G.camY + rows));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = idx(x, y);
      if (!G.seen[i]) continue;
      const t = G.map[i];
      const img =
        t == WALL ? SPR.wall : t == SAFE ? SPR.safe : t == STAIRS ? SPR.stairs : SPR.floor[(x * 7 + y * 13) % 3];
      cx.drawImage(img, sx(x), sy(y), TS + 0.5, TS + 0.5);
      if (!G.vis[i]) {
        cx.fillStyle = 'rgba(13,9,18,.62)';
        cx.fillRect(sx(x), sy(y), TS + 0.5, TS + 0.5);
      }
    }
  for (const L of G.lairs || [])
    if (L.sealed)
      for (const [i] of L.bar) {
        const bx = i % G.W,
          by = (i / G.W) | 0;
        cx.fillStyle = 'rgba(255,61,127,.55)';
        cx.fillRect(sx(bx), sy(by), TS, TS);
        cx.strokeStyle = '#ff3d7f';
        cx.lineWidth = 2;
        cx.strokeRect(sx(bx) + 2, sy(by) + 2, TS - 4, TS - 4);
      }
  const S = (img, x, y) => cx.drawImage(img, sx(x), sy(y), TS, TS);
  for (const c of G.corpses) if (G.vis[idx(c.x, c.y)]) S(SPR.corpse, c.x, c.y);
  for (const it of G.items) if (G.vis[idx(it.x, it.y)]) S(SPR[it.k], it.x, it.y);
  for (const m of G.mobs) {
    if (!G.vis[idx(m.x, m.y)] && m.scouted && G.seen[idx(m.x, m.y)]) {
      cx.globalAlpha = 0.45;
      S(SPR[m.spr], m.x, m.y);
      cx.globalAlpha = 1;
      cx.fillStyle = '#5fe0d0';
      cx.font = '700 10px sans-serif';
      cx.textAlign = 'left';
      cx.fillText('L' + m.level, sx(m.x) + 1, sy(m.y) + 9);
      continue;
    }
    if (!G.vis[idx(m.x, m.y)]) continue;
    if (m.anguish > 0) {
      cx.fillStyle = 'rgba(199,125,255,.35)';
      cx.beginPath();
      cx.arc(sx(m.x + 0.5), sy(m.y + 0.55), TS * 0.48, 0, 7);
      cx.fill();
    }
    if (m.role == 'janitor' && m.eaten) {
      const k = Math.min(1.5, 1 + m.eaten * 0.12),
        o = ((k - 1) * TS) / 2;
      cx.drawImage(SPR[m.spr], sx(m.x) - o, sy(m.y) - o * 1.6, TS * k, TS * k);
    } else S(SPR[m.spr], m.x, m.y);
    if (!m.hostile && !m.charmed && !m.ally) {
      cx.strokeStyle = 'rgba(255,255,255,.85)';
      cx.lineWidth = 1.5;
      cx.beginPath();
      cx.arc(sx(m.x) + TS * 0.16, sy(m.y) + TS * 0.16, TS * 0.09, 0, 7);
      cx.stroke();
    }
    if (m.ally) {
      cx.fillStyle = 'rgba(95,224,208,.22)';
      cx.fillRect(sx(m.x), sy(m.y), TS, TS);
      cx.strokeStyle = '#5fe0d0';
      cx.lineWidth = 2;
      cx.strokeRect(sx(m.x) + 1, sy(m.y) + 1, TS - 2, TS - 2);
    }
    if (m.charmed) {
      cx.fillStyle = '#ff7ab6';
      cx.font = `700 ${Math.round(TS * 0.4)}px sans-serif`;
      cx.textAlign = 'center';
      cx.fillText('♥', sx(m.x + 0.85), sy(m.y + 0.3));
    }
    if (m.burn) {
      cx.fillStyle = 'rgba(255,140,40,.35)';
      cx.fillRect(sx(m.x), sy(m.y), TS, TS);
    }
    if (m.boss) {
      cx.strokeStyle = '#ff3d7f';
      cx.lineWidth = 2;
      cx.strokeRect(sx(m.x) + 1, sy(m.y) + 1, TS - 2, TS - 2);
    }
    if (m.hp < m.maxhp) {
      cx.fillStyle = '#120b18';
      cx.fillRect(sx(m.x) + 3, sy(m.y) - 2, TS - 6, 4);
      cx.fillStyle = '#ff5a6e';
      cx.fillRect(sx(m.x) + 3, sy(m.y) - 2, (TS - 6) * Math.max(0, m.hp / m.maxhp), 4);
    }
  }
  if (!G.pet.down && G.vis[idx(G.pet.x, G.pet.y)]) S(SPR.pet, G.pet.x, G.pet.y);
  S(SPR.hero, p.x, p.y);
  const lx = sx(p.x + 0.5),
    ly = sy(p.y + 0.5),
    g = cx.createRadialGradient(lx, ly, TS * 2, lx, ly, TS * 8.5);
  g.addColorStop(0, 'rgba(13,9,18,0)');
  g.addColorStop(1, 'rgba(13,9,18,.6)');
  cx.fillStyle = g;
  cx.fillRect(0, 0, W, H);
  cx.textAlign = 'center';
  cx.font = `700 ${Math.round(TS * 0.45)}px "Chakra Petch",sans-serif`;
  G.fx = G.fx.filter(f => {
    const a = Math.max(0, (now - f.t) / (f.k == 'f' ? 850 : f.k == 'boom' ? 420 : 260));
    if (a >= 1) return false;
    // never reveal what happens on tiles the player can't see
    const visAt = (x, y) => x >= 0 && y >= 0 && x < G.W && y < G.H && G.vis[idx(x, y)];
    if (f.k == 'bolt' ? !visAt(f.a.x, f.a.y) && !visAt(f.b.x, f.b.y) : !visAt(f.x, f.y)) return false;
    if (f.k == 'f') {
      cx.globalAlpha = 1 - a;
      cx.fillStyle = '#000';
      const yy = sy(f.y) + TS * 0.25 - (reduced ? 0 : a * TS * 0.7);
      cx.fillText(f.txt, sx(f.x + 0.5) + 1, yy + 1);
      cx.fillStyle = f.col;
      cx.fillText(f.txt, sx(f.x + 0.5), yy);
    } else if (f.k == 'boom') {
      cx.globalAlpha = 1 - a;
      cx.fillStyle = f.col || '#ffb347';
      cx.beginPath();
      cx.arc(sx(f.x + 0.5), sy(f.y + 0.5), TS * (0.5 + a * 1.2), 0, 7);
      cx.fill();
      cx.fillStyle = '#fff3c4';
      cx.beginPath();
      cx.arc(sx(f.x + 0.5), sy(f.y + 0.5), TS * 0.5 * (1 - a), 0, 7);
      cx.fill();
    } else {
      cx.globalAlpha = 1 - a;
      cx.strokeStyle = f.col || '#c9a6ff';
      cx.lineWidth = 3;
      cx.beginPath();
      cx.moveTo(sx(f.a.x + 0.5), sy(f.a.y + 0.5));
      cx.lineTo(sx(f.b.x + 0.5), sy(f.b.y + 0.5));
      cx.stroke();
    }
    cx.globalAlpha = 1;
    return true;
  });
  if (fresh) drawMini(); // the minimap only changes with game state, not with animation
}
requestAnimationFrame(draw);
// =====================================================================================================
// MINIMAP
// =====================================================================================================
const mini = $('#mini'),
  mx = mini.getContext('2d');
// Minimap display mode, cycled by M, the Map button, or clicking the minimap: small -> full floor -> off -> small.
// The full-floor view needs the dungeon-sign HUD upgrade, so until then the cycle is small <-> off.
let mapMode = 'small',
  miniBig = false; // shorthand for mapMode == 'big', used by the drawing code
let miniGeo = null; // last minimap transform, for hit-testing the dots under the pointer
function setMapMode(mode) {
  mapMode = mode;
  miniBig = mode == 'big';
  mini.hidden = mode == 'off';
  if (G) ui();
  needsDraw = true;
}
function toggleMap() {
  const order = G && G.hud ? ['small', 'big', 'off'] : ['small', 'off'];
  setMapMode(order[(order.indexOf(mapMode) + 1) % order.length]);
  if (G && !G.hud && !G.mapHint) {
    G.mapHint = true;
    log('The full-floor map view unlocks once you read an official dungeon sign.', 'dim');
  }
}
// Minimap: hover a dot (or long-press on touch) for its info card; a click/tap cycles the map mode.
let miniHold = null,
  miniHeld = false;
mini.addEventListener('pointermove', e => {
  if (e.pointerType == 'mouse') miniTip(e.clientX, e.clientY);
});
mini.addEventListener('pointerleave', e => {
  if (e.pointerType == 'mouse') tipEl.hidden = true;
});
mini.addEventListener('pointerdown', e => {
  e.stopPropagation();
  miniHeld = false;
  if (e.pointerType != 'mouse') {
    clearTimeout(miniHold);
    const X = e.clientX,
      Y = e.clientY;
    miniHold = setTimeout(() => {
      miniHold = null;
      if (miniTip(X, Y)) miniHeld = true;
    }, 450);
  }
});
mini.addEventListener('pointerup', e => {
  e.stopPropagation();
  clearTimeout(miniHold);
  miniHold = null;
  if (miniHeld) {
    setTimeout(() => (tipEl.hidden = true), 2500);
    return;
  }
  tipEl.hidden = true;
  toggleMap();
});
// Minimap: explored tiles in blue/gray, safe rooms always visible, dots for crawlers and (after the HUD
// upgrade) monsters and corpses. Expanded mode shows the whole floor, neighborhoods and a legend.
function drawMini() {
  if (!G || !G.map || mapMode == 'off') return;
  if (!G.hud && miniBig) setMapMode('small');
  const p = G.player,
    fw = fig.clientWidth,
    fh = fig.clientHeight,
    dp = window.devicePixelRatio || 1;
  const W = miniBig ? fw - 20 : fw < 560 ? 120 : 168,
    H = miniBig ? fh - 20 : W;
  if (mini.width !== Math.round(W * dp) || mini.height !== Math.round(H * dp)) {
    mini.width = Math.round(W * dp);
    mini.height = Math.round(H * dp);
    mini.style.width = W + 'px';
    mini.style.height = H + 'px';
  }
  mx.setTransform(dp, 0, 0, dp, 0, 0);
  mx.fillStyle = '#141821';
  mx.fillRect(0, 0, W, H);
  const span = 41,
    legend = miniBig ? (W < 520 ? 48 : 30) : 0;
  let cell,
    x0,
    y0,
    ox = 0,
    oy = 0;
  if (miniBig) {
    cell = Math.min(W / G.W, (H - legend - 8) / G.H);
    x0 = 0;
    y0 = 0;
    ox = (W - cell * G.W) / 2;
    oy = 4;
  } else {
    cell = W / span;
    x0 = p.x - (span >> 1);
    y0 = p.y - (span >> 1);
  }
  const cols = miniBig ? G.W : span,
    rows = miniBig ? G.H : span,
    X = x => ox + (x - x0) * cell,
    Y = y => oy + (y - y0) * cell;
  miniGeo = { X, Y, cell };
  for (let yy = 0; yy < rows; yy++)
    for (let xx = 0; xx < cols; xx++) {
      const x = x0 + xx,
        y = y0 + yy;
      if (x < 0 || y < 0 || x >= G.W || y >= G.H) continue;
      const i = idx(x, y),
        t = G.map[i];
      let c = null;
      if (t == SAFE)
        c = G.seen[i] ? '#f5c542' : 'rgba(245,197,66,.6)'; // safe rooms always show, even in fog
      else if (G.seen[i]) c = t == WALL ? '#6b7685' : t == STAIRS ? '#ffffff' : '#3d5f8f';
      if (c) {
        mx.fillStyle = c;
        mx.fillRect(X(x), Y(y), cell + 0.4, cell + 0.4);
      }
    }
  const dot = (x, y, col, r) => {
    mx.fillStyle = col;
    mx.beginPath();
    mx.arc(X(x + 0.5), Y(y + 0.5), r, 0, 7);
    mx.fill();
  };
  const rr = Math.max(1.8, cell * 0.55);
  if (G.hud)
    for (const c of G.corpses)
      if (G.seen[idx(c.x, c.y)]) {
        mx.strokeStyle = '#e05a5a';
        mx.lineWidth = 1.2;
        const a = X(c.x) + cell * 0.15,
          b = Y(c.y) + cell * 0.15,
          z = cell * 0.7;
        mx.beginPath();
        mx.moveTo(a, b);
        mx.lineTo(a + z, b + z);
        mx.moveTo(a + z, b);
        mx.lineTo(a, b + z);
        mx.stroke();
      }
  if (G.hud)
    for (const m of G.mobs) {
      const i = idx(m.x, m.y);
      if (!(G.vis[i] || (m.scouted && G.seen[i]))) continue;
      dot(m.x, m.y, m.ally ? '#5fe0d0' : m.charmed || !m.hostile ? '#ffffff' : '#ff4d4d', m.boss ? rr * 1.6 : rr);
      if (miniBig && m.scouted && !G.vis[i] && cell >= 6) {
        mx.fillStyle = '#ffd0d0';
        mx.font = '9px sans-serif';
        mx.textAlign = 'left';
        mx.fillText(m.level, X(m.x + 1), Y(m.y + 0.6));
      }
    }
  if (!G.pet.down) dot(G.pet.x, G.pet.y, '#4fb3ff', rr);
  mx.strokeStyle = '#fff';
  mx.lineWidth = 1.2;
  dot(p.x, p.y, '#4ade80', rr * 1.25);
  mx.beginPath();
  mx.arc(X(p.x + 0.5), Y(p.y + 0.5), rr * 1.25, 0, 7);
  mx.stroke();
  if (miniBig) {
    mx.setLineDash([4, 4]);
    mx.strokeStyle = 'rgba(255,255,255,.25)';
    mx.lineWidth = 1;
    mx.beginPath();
    mx.moveTo(X(G.W / 2), Y(0));
    mx.lineTo(X(G.W / 2), Y(G.H));
    mx.moveTo(X(0), Y(G.H / 2));
    mx.lineTo(X(G.W), Y(G.H / 2));
    mx.stroke();
    mx.setLineDash([]);
    mx.font = '600 11px Rubik,sans-serif';
    mx.fillStyle = 'rgba(255,255,255,.55)';
    mx.textAlign = 'center';
    HOODN.forEach((n, h) => {
      const cx2 = X((h % 2 ? 0.75 : 0.25) * G.W),
        cy2 = Y((h < 2 ? 0.25 : 0.75) * G.H);
      mx.fillText(n + (G.hoodsMapped.has(h) ? ' · mapped' : ''), cx2, cy2);
    });
    const items = [
      ['#4ade80', 'You'],
      ['#4fb3ff', NAMES.pet],
      ['#ff4d4d', 'Hostile'],
      ['#ffffff', 'Neutral'],
      ['#f5c542', 'Safe room'],
      ['#e05a5a', '✕ Corpse'],
      ['sq', 'Stairwell'],
    ];
    let lx = 10,
      ly = H - legend + 16;
    mx.textAlign = 'left';
    mx.font = '12px Rubik,sans-serif';
    for (const [c, t] of items) {
      const w = (t[0] == '✕' ? 0 : 13) + mx.measureText(t).width + 14;
      if (lx + w > W - 8) {
        lx = 10;
        ly += 18;
      }
      if (c == 'sq') {
        mx.fillStyle = '#fff';
        mx.fillRect(lx + 1, ly - 8, 8, 8);
        lx += 13;
      } else if (t[0] != '✕') {
        mx.fillStyle = c;
        mx.beginPath();
        mx.arc(lx + 5, ly - 4, 4, 0, 7);
        mx.fill();
        lx += 13;
      }
      mx.fillStyle = '#cfd6e2';
      mx.fillText(t, lx, ly);
      lx += mx.measureText(t).width + 14;
    }
    if (W >= 520) {
      mx.fillStyle = 'rgba(207,214,226,.6)';
      mx.textAlign = 'right';
      mx.fillText('M or click to close', W - 10, ly);
    }
  }
}

// =====================================================================================================
// INPUT
// =====================================================================================================
const KEYS = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  w: [0, -1],
  s: [0, 1],
  a: [-1, 0],
  d: [1, 0],
  k: [0, -1],
  j: [0, 1],
  h: [-1, 0],
  l: [1, 0],
  y: [-1, -1],
  u: [1, -1],
  b: [-1, 1],
  n: [1, 1],
  7: [-1, -1],
  8: [0, -1],
  9: [1, -1],
  4: [-1, 0],
  6: [1, 0],
  1: [-1, 1],
  2: [0, 1],
  3: [1, 1],
  5: [0, 0],
  '.': [0, 0],
  ' ': [0, 0],
};
const ACTS = {
  missile: castMissile,
  heal: castHeal,
  quaff,
  bomb,
  map: () => toggleMap(),
  rest,
  open: openBoxes,
  descend: descendAct,
  help: () => {
    if (!busy()) help();
  },
};
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!$('#modal').hidden) {
    if (e.key == 'Enter' || (e.key == 'Escape' && !$('#mcard').dataset.noesc)) {
      e.preventDefault();
      const b = $('#mcard .mbtn.primary') || $('#mcard .mbtn');
      b && b.click();
    }
    return;
  }
  const k = e.key.length == 1 ? e.key.toLowerCase() : e.key;
  if (KEYS[k] && !(k == ' ' && document.activeElement && document.activeElement.tagName == 'BUTTON')) {
    e.preventDefault();
    move(...KEYS[k]);
    return;
  }
  const map = {
    f: 'missile',
    c: 'heal',
    q: 'quaff',
    t: 'bomb',
    m: 'map',
    r: 'rest',
    o: 'open',
    '>': 'descend',
    '?': 'help',
  };
  if (map[e.key] || map[k]) {
    e.preventDefault();
    ACTS[map[e.key] || map[k]]();
  }
});
document.querySelector('.panel').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.dir) {
    const [dx, dy] = b.dataset.dir.split(',').map(Number);
    move(dx, dy);
  } else if (b.dataset.act) ACTS[b.dataset.act]();
  else if (b.dataset.stat) spend(b.dataset.who == 'pet' ? G.pet : G.player, b.dataset.stat);
});
// hover (mouse) or press-and-hold (touch) on a visible monster shows its info card
const tipEl = $('#tip');
let hoverPt = null,
  holdT = null,
  held = false;
// Screen position -> map tile under the pointer.
function tileAt(cxp, cyp) {
  const r = cv.getBoundingClientRect();
  return {
    x: Math.floor(G.camX + (cxp - r.left) / TS),
    y: Math.floor(G.camY + (cyp - r.top) / TS),
    px: cxp - r.left,
    py: cyp - r.top,
  };
}
// Monster info card for the visible (or Field-Guide-scouted) mob under the pointer.
function showTip(cxp, cyp) {
  if (!G || G.camX == null) {
    tipEl.hidden = true;
    return false;
  }
  const t = tileAt(cxp, cyp);
  const m = G.mobs.find(o => o.x == t.x && o.y == t.y && mobShown(o));
  if (!m) {
    tipEl.hidden = true;
    return false;
  }
  tipEl.innerHTML = mobTipHTML(m);
  placeTip(t.px, t.py);
  return true;
}
// A monster is shown (on the map and in info cards) if it's in view or was scouted by a Neighborhood Map.
const mobShown = o => G.vis[idx(o.x, o.y)] || (o.scouted && G.seen[idx(o.x, o.y)]);
// Info card contents for monster m.
function mobTipHTML(m) {
  const p = G.player,
    dist = cheb(m, p),
    status = m.ally
      ? `Your undead minion · ${m.timer} turns left`
      : m.charmed
        ? `Charmed by ${m.charmedBy || NAMES.pet}`
        : !m.hostile
          ? 'Neutral: won’t attack unless provoked'
          : !m.awake
            ? 'Hasn’t noticed you'
            : dist == 1
              ? 'Right next to you'
              : 'Hunting you';
  const youHit = Math.max(50, Math.min(95, 70 + st(p, 'dex') * 2 - m.dodge));
  return `<h4 class="${m.boss ? 'boss' : ''}">${m.name}</h4><div class="lvlline">Level ${m.level} ${m.boss ? m.tier + ' Boss' : `${m.famName}${m.ranks > 1 ? ` · type ${m.rank} of ${m.ranks}` : ''}`}${lvlTag(m.level)}</div><div class="role">${ROLES[m.role] || (m.boss ? 'Boss: hits hard and won’t leave its lair.' : '')}${m.faction ? ` Sworn enemies: ${FFOES[m.faction].map(f => FAM[f].name + 's').join(', ')}.` : ''}</div><div class="meta">${status} · ${dist} tile${dist == 1 ? '' : 's'} away${m.burn ? ' · On fire' : ''}${m.psn ? ' · Poisoned' : ''}${m.foe && G.mobs.includes(m.foe) ? ` · Fighting the ${m.foe.name}` : ''}${m.anguish > 0 ? ' · Empowered by Anguish' : ''}${effArm(m) > m.arm ? ' · Rallied (+1 armor)' : ''}${m.eaten ? ` · Corpses eaten: ${m.eaten}` : ''}${m.loot && m.loot.length ? ` · Holding ${m.loot.length} item${m.loot.length > 1 ? 's' : ''}` : ''}${m.range && m.role != 'support' ? (m.cd ? ` · Reloading (${m.cd})` : ' · Ready to fire') : ''}</div>
   <div class="tstats"><div><span>HP</span><b>${m.hp} / ${m.maxhp}</b></div><div><span>Attack</span><b>${m.lo}–${m.hi}</b></div><div><span>Armor</span><b>${m.arm}</b></div>
   <div><span>Dodge</span><b>${m.dodge}%</b></div><div><span>Your hit</span><b>${youHit}%</b></div><div><span>XP</span><b>${m.xp}</b></div></div>
   <p>${m.desc || ''}</p><p class="ttip">System AI tip: ${m.tip || 'Hit it until it stops moving.'}</p>`;
}
// Short card for Carl or Donut.
function crawlerTipHTML(c) {
  const isPet = c === G.pet;
  return `<h4>${c.name}</h4><div class="lvlline">Level ${c.lvl} ${isPet ? 'Cat' : RACES[c.raceKey || 'human'].name}${c.cls ? ' · ' + CLASSES[c.cls].name : ''}</div><div class="meta">${isPet ? (c.down ? 'Knocked out' : `${cheb(c, G.player)} tile(s) from you`) : 'You are here'}</div><div class="tstats"><div><span>HP</span><b>${c.hp} / ${c.maxhp}</b></div><div><span>MP</span><b>${c.mp} / ${c.maxmp}</b></div><div><span>Kills</span><b>${c.kills}</b></div></div>`;
}
// Position the shown card near (px, py), in coordinates relative to the play area, keeping it on screen.
function placeTip(px, py) {
  tipEl.hidden = false;
  const fw = fig.clientWidth,
    fh = fig.clientHeight,
    tw = tipEl.offsetWidth,
    th = tipEl.offsetHeight;
  let lx = px + 18,
    ly = py + 18;
  if (lx + tw > fw - 8) lx = px - tw - 18;
  if (lx < 8) lx = 8;
  if (ly + th > fh - 8) ly = Math.max(8, py - th - 18);
  tipEl.style.left = lx + 'px';
  tipEl.style.top = ly + 'px';
}
// Info card for the dot under the pointer on the minimap: a monster the map shows, Carl, or Donut.
function miniTip(cxp, cyp) {
  if (!G || !miniGeo || mapMode == 'off') {
    tipEl.hidden = true;
    return false;
  }
  const r = mini.getBoundingClientRect(),
    mxp = cxp - r.left,
    myp = cyp - r.top,
    { X, Y, cell } = miniGeo,
    reach = Math.max(7, cell * 1.2);
  let best = null,
    bd = reach;
  const consider = (o, html) => {
    const d = Math.hypot(X(o.x + 0.5) - mxp, Y(o.y + 0.5) - myp);
    if (d <= bd) {
      bd = d;
      best = html;
    }
  };
  if (G.hud) for (const m of G.mobs) if (mobShown(m)) consider(m, () => mobTipHTML(m));
  if (!G.pet.down) consider(G.pet, () => crawlerTipHTML(G.pet));
  consider(G.player, () => crawlerTipHTML(G.player));
  if (!best) {
    tipEl.hidden = true;
    return false;
  }
  tipEl.innerHTML = best();
  const f = fig.getBoundingClientRect();
  placeTip(cxp - f.left, cyp - f.top);
  return true;
}
const lvlTag = l => {
  const d = l - G.player.lvl;
  return d >= 3
    ? ' <span class="lt hard">Dangerous</span>'
    : d >= 1
      ? ' <span class="lt tough">Tougher than you</span>'
      : d <= -3
        ? ' <span class="lt easy">Pushover</span>'
        : '';
};
const refreshTip = () => {
  if (hoverPt) showTip(hoverPt.x, hoverPt.y);
};
cv.addEventListener('pointermove', e => {
  if (e.pointerType == 'mouse') {
    hoverPt = { x: e.clientX, y: e.clientY };
    showTip(e.clientX, e.clientY);
  }
});
cv.addEventListener('pointerleave', () => {
  hoverPt = null;
  tipEl.hidden = true;
});
cv.addEventListener('pointerdown', e => {
  if (busy()) return;
  held = false;
  if (e.pointerType != 'mouse') {
    clearTimeout(holdT);
    const X = e.clientX,
      Y = e.clientY;
    holdT = setTimeout(() => {
      holdT = null;
      if (showTip(X, Y)) {
        held = true;
        hoverPt = null;
      }
    }, 450);
  }
});
cv.addEventListener('pointerup', e => {
  if (e.pointerType != 'mouse') {
    clearTimeout(holdT);
    holdT = null;
    if (held) {
      setTimeout(() => (tipEl.hidden = true), 2500);
      return;
    }
    tipEl.hidden = true;
  }
  if (busy() || G.camX == null) return;
  const t = tileAt(e.clientX, e.clientY);
  move(Math.sign(t.x - G.player.x), Math.sign(t.y - G.player.y));
});
cv.addEventListener('contextmenu', e => e.preventDefault());

newGame();
help();
