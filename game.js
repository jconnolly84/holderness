/* Holderness: Coast Defender
   Quick-build KS3 arcade/strategy mini-game.
   Edit towns/costs/difficulty in CONFIG below.
*/
const CONFIG = {
  width: 960,
  height: 540,
  segments: 9,

  startingBudget: 600,
  budgetPerSecond: 6,

  waveSpawnMs: 900,
  waveSpeed: 120,
  waveDamage: 8,

  stormEveryMs: 35000,
  stormDurationMs: 9000,
  stormDamageMultiplier: 2.0,
  stormSpawnMultiplier: 1.35,

  // Coastline base x (retreat shifts this left)
  coastX: 260,
  retreatPerHit: 1.8,       // px per unprotected hit
  retreatPerHitStorm: 2.7,

  // Towns from north (top) to south (bottom)
  towns: [
    { name: "Bridlington", value: 120, yIndex: 1 },
    { name: "Hornsea", value: 160, yIndex: 3 },
    { name: "Mappleton", value: 180, yIndex: 4 },
    { name: "Withernsea", value: 140, yIndex: 6 },
    { name: "Easington (Gas)", value: 260, yIndex: 7 },
    { name: "Spurn", value: 100, yIndex: 8 },
  ],

  tools: {
    seawall:  { cost: 350, reduce: 0.85, hp: 260, tag: "Hard engineering" },
    rocks:    { cost: 220, reduce: 0.65, hp: 200, tag: "Hard engineering" },
    groyne:   { cost: 160, reduce: 0.45, hp: 160, tag: "Hard engineering (drift)" },
    nourish:  { cost: 120, reduce: 0.55, hp: 120, expiresMs: 14000, tag: "Soft engineering" },
    retreat:  { cost:  80, reduce: 0.00, hp: 1, tag: "Managed retreat" },
  },

  // Groyne down-drift effect:
  // Each groyne placed increases damage for segments SOUTH of it.
  groyneDownDriftExtra: 0.22, // per groyne (additive)
};

const $ = (sel) => document.querySelector(sel);
const budgetEl = $("#budget");
const scoreEl  = $("#score");
const stormEl  = $("#storm");
const selectedEl = $("#selected");

let selectedTool = null;
let phaserGame = null;

function money(n){
  return "£" + Math.max(0, Math.round(n)).toLocaleString("en-GB");
}

function openModal(title, html){
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = html;
  $("#modal").classList.remove("hidden");
}

function closeModal(){
  $("#modal").classList.add("hidden");
}

$("#modalClose").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => {
  if (e.target.id === "modal") closeModal();
});

$("#howtoBtn").addEventListener("click", () => {
  openModal("How to play", `
    <p><strong>Goal:</strong> keep towns alive as waves erode the Holderness cliffs.</p>
    <ul>
      <li>Select a defence, then <strong>click a coastal segment</strong> to place it.</li>
      <li><strong>Storm surges</strong> happen periodically — erosion is stronger and waves spawn faster.</li>
      <li><strong>Groynes</strong> help locally but can increase erosion <em>down‑drift</em> (south).</li>
      <li><strong>Managed retreat</strong> is cheap: you accept land loss in one place to focus resources elsewhere.</li>
    </ul>
    <p><strong>KS3 link:</strong> longshore drift, abrasion/hydraulic action, hard vs soft engineering, sustainability.</p>
  `);
});

$("#restartBtn").addEventListener("click", () => {
  if (phaserGame){
    phaserGame.destroy(true);
    phaserGame = null;
  }
  startGame();
});

// Toolbox selection
document.querySelectorAll(".tool").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tool").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedTool = btn.dataset.tool;
    selectedEl.textContent = btn.querySelector("span").textContent;
  });
});

class MainScene extends Phaser.Scene {
  constructor(){
    super("main");
    this.segmentH = CONFIG.height / CONFIG.segments;
    this.coast = [];       // coastline x per segment
    this.defences = [];    // per segment defence object or null
    this.defenceSprites = [];
    this.groyneCountSouthOf = []; // for quick down-drift calc
    this.score = 0;
    this.budget = CONFIG.startingBudget;
    this.stormActive = false;
    this.nextStormAt = 0;
    this.stormEndsAt = 0;
    this.lastBudgetTick = 0;
    this.lastWaveSpawn = 0;
    this.waves = null;
    this.townSprites = [];
    this.townHP = [];      // per town index
    this.townAlive = [];
    this.townText = [];
    this.gameOver = false;
  }

  preload(){
    this.load.image("bg", "assets/img/bg.png");
    this.load.image("wave", "assets/img/wave.png");
    this.load.image("particle", "assets/img/particle.png");
    this.load.image("town", "assets/img/town.png");

    this.load.image("i_seawall", "assets/img/icon_seawall.png");
    this.load.image("i_rocks", "assets/img/icon_rocks.png");
    this.load.image("i_groyne", "assets/img/icon_groyne.png");
    this.load.image("i_nourish", "assets/img/icon_nourish.png");
    this.load.image("i_retreat", "assets/img/icon_retreat.png");
  }

  create(){
    this.add.image(CONFIG.width/2, CONFIG.height/2, "bg");

    // init coastline (slight jag)
    for (let i=0;i<CONFIG.segments;i++){
      const jitter = Phaser.Math.Between(-14, 14);
      this.coast[i] = CONFIG.coastX + jitter;
      this.defences[i] = null;
      this.defenceSprites[i] = null;
    }

    // clickable segment hitboxes
    for (let i=0;i<CONFIG.segments;i++){
      const y = i*this.segmentH + this.segmentH/2;
      const zone = this.add.zone(CONFIG.coastX/2, y, CONFIG.coastX, this.segmentH);
      zone.setInteractive({ useHandCursor: true });
      zone.on("pointerdown", () => this.placeDefence(i));
    }

    // draw coastline polyline (graphics)
    this.coastG = this.add.graphics();
    this.redrawCoast();

    // waves group
    this.waves = this.physics.add.group();

    // towns
    CONFIG.towns.forEach((t, idx) => {
      const y = t.yIndex*this.segmentH + this.segmentH/2;
      const x = this.coast[t.yIndex] - 44;
      const spr = this.add.image(x, y, "town").setScale(0.95);
      spr.setDepth(5);
      this.townSprites[idx] = spr;
      this.townHP[idx] = 100;
      this.townAlive[idx] = true;

      const txt = this.add.text(x+18, y-20, `${t.name}\nHP: 100`, {
        fontFamily: "system-ui,Segoe UI,Arial", fontSize: "12px", color: "#e8eefc",
        stroke: "#000000", strokeThickness: 3
      });
      txt.setDepth(6);
      this.townText[idx] = txt;
    });

    // storm scheduling
    const now = this.time.now;
    this.nextStormAt = now + CONFIG.stormEveryMs;
    this.lastBudgetTick = now;
    this.lastWaveSpawn = now;

    // splash particles
    this.particles = this.add.particles(0,0,"particle",{
      speed: { min: 40, max: 160 },
      lifespan: { min: 250, max: 700 },
      scale: { start: 1, end: 0 },
      quantity: 8,
      emitting: false
    });
    this.particles.setDepth(4);

    // UI initial
    this.syncUI();

    // tooltip on click sea for quick fact
    this.input.on("pointerdown", (pointer) => {
      if (this.gameOver) return;
      // if clicked on sea (right side), show quick process hint sometimes
      if (pointer.x > CONFIG.coastX + 180 && Math.random() < 0.18){
        const facts = [
          "Hydraulic action: air forced into cracks by waves.",
          "Abrasion: rocks grind against the cliff like sandpaper.",
          "Attrition: rocks smash together and get smaller/rounder.",
          "Longshore drift moves sediment along the coast at an angle."
        ];
        this.flashHint(facts[Math.floor(Math.random()*facts.length)]);
      }
    });
  }

  flashHint(msg){
    const t = this.add.text(CONFIG.width/2, 28, msg, {
      fontFamily:"system-ui,Segoe UI,Arial",
      fontSize:"14px",
      color:"#ffffff",
      backgroundColor:"rgba(0,0,0,.55)",
      padding:{left:10,right:10,top:6,bottom:6}
    }).setOrigin(0.5,0.5).setDepth(20);
    this.tweens.add({
      targets: t, alpha: 0, duration: 2200, ease: "Sine.easeIn",
      onComplete: () => t.destroy()
    });
  }

  redrawCoast(){
    this.coastG.clear();
    this.coastG.lineStyle(6, 0x5a4630, 1);
    this.coastG.beginPath();
    this.coastG.moveTo(this.coast[0], 0);
    for (let i=1;i<CONFIG.segments;i++){
      this.coastG.lineTo(this.coast[i], i*this.segmentH);
    }
    this.coastG.lineTo(this.coast[CONFIG.segments-1], CONFIG.height);
    this.coastG.strokePath();
  }

  placeDefence(seg){
    if (this.gameOver) return;
    if (!selectedTool){
      this.flashHint("Select a defence first.");
      return;
    }
    const tool = CONFIG.tools[selectedTool];
    if (!tool) return;

    if (this.defences[seg] && this.defences[seg].type !== "retreat"){
      this.flashHint("That segment already has a defence.");
      return;
    }

    if (this.budget < tool.cost){
      this.flashHint("Not enough budget.");
      return;
    }

    // Managed retreat: clear any defence, retreat coastline a bit, give small budget boost (long-term realism)
    if (selectedTool === "retreat"){
      this.budget -= tool.cost;
      // retreat immediately (accept loss)
      this.coast[seg] = Math.max(90, this.coast[seg] - 24);
      if (this.defenceSprites[seg]){ this.defenceSprites[seg].destroy(); this.defenceSprites[seg]=null; }
      this.defences[seg] = { type:"retreat", hp:1, placedAt:this.time.now };
      this.redrawCoast();
      this.flashHint("Managed retreat chosen: land loss accepted here.");
      this.score += 20;
      this.syncUI();
      return;
    }

    // Place/replace
    this.budget -= tool.cost;

    if (this.defenceSprites[seg]) this.defenceSprites[seg].destroy();

    const y = seg*this.segmentH + this.segmentH/2;
    const x = this.coast[seg] + 22;

    const key = selectedTool === "seawall" ? "i_seawall"
      : selectedTool === "rocks" ? "i_rocks"
      : selectedTool === "groyne" ? "i_groyne"
      : selectedTool === "nourish" ? "i_nourish"
      : "i_retreat";

    const spr = this.add.image(x, y, key).setScale(0.92);
    spr.setDepth(3);

    this.defenceSprites[seg] = spr;
    this.defences[seg] = {
      type: selectedTool,
      hp: tool.hp,
      reduce: tool.reduce,
      placedAt: this.time.now,
      expiresMs: tool.expiresMs || null
    };

    if (selectedTool === "groyne"){
      this.flashHint("Groyne placed: watch down‑drift erosion!");
    } else if (selectedTool === "nourish"){
      this.flashHint("Beach nourishment: temporary protection.");
    } else {
      this.flashHint("Defence placed.");
    }

    this.syncUI();
  }

  calcDownDriftExtra(seg){
    // sum groynes north of this segment
    let extra = 0;
    for (let i=0;i<seg;i++){
      if (this.defences[i] && this.defences[i].type === "groyne"){
        extra += CONFIG.groyneDownDriftExtra;
      }
    }
    return extra; // additive to damage multiplier
  }

  spawnWave(){
    const yIndex = Phaser.Math.Between(0, CONFIG.segments-1);
    const y = yIndex*this.segmentH + this.segmentH/2 + Phaser.Math.Between(-16,16);
    const x = CONFIG.width + 30;
    const w = this.waves.create(x, y, "wave");
    w.setDepth(2);
    w.setVelocityX(-CONFIG.waveSpeed * (this.stormActive ? 1.25 : 1.0));
    w.setData("yIndex", yIndex);
    w.setData("strength", 1.0);
    w.setScale(Phaser.Math.FloatBetween(0.8, 1.1));
    w.setAlpha(Phaser.Math.FloatBetween(0.75, 0.95));
  }

  hitCoast(wave){
    const seg = wave.getData("yIndex");
    const tool = this.defences[seg];
    const stormMult = this.stormActive ? CONFIG.stormDamageMultiplier : 1.0;

    // base damage
    let dmg = CONFIG.waveDamage * stormMult;

    // groyne down-drift penalty (south segments only)
    const dd = this.calcDownDriftExtra(seg);
    dmg *= (1 + dd);

    // reduce by defence
    if (tool && tool.type !== "retreat"){
      dmg *= (1 - tool.reduce);
      tool.hp -= (CONFIG.waveDamage * 0.9) * stormMult;

      // nourish expires
      if (tool.expiresMs && (this.time.now - tool.placedAt) > tool.expiresMs){
        this.removeDefence(seg, "Nourishment washed away.");
      } else if (tool.hp <= 0){
        this.removeDefence(seg, "Defence failed.");
      }
    } else {
      // unprotected coast retreats
      const retreat = this.stormActive ? CONFIG.retreatPerHitStorm : CONFIG.retreatPerHit;
      this.coast[seg] = Math.max(70, this.coast[seg] - retreat);
      this.redrawCoast();
      // damage any town on that segment
      this.applyTownDamage(seg, dmg);
    }

    // score for surviving hits
    this.score += Math.round(6 * stormMult);
    this.syncUI();

    // particles
    this.particles.emitParticleAt(this.coast[seg] + 18, seg*this.segmentH + this.segmentH/2, 12);

    // screen shake for storm hits
    if (this.stormActive && Math.random() < 0.35){
      this.cameras.main.shake(120, 0.004);
    }
  }

  removeDefence(seg, msg){
    if (this.defenceSprites[seg]){
      this.tweens.add({
        targets: this.defenceSprites[seg],
        alpha: 0, duration: 250,
        onComplete: () => {
          this.defenceSprites[seg].destroy();
          this.defenceSprites[seg] = null;
        }
      });
    }
    this.defences[seg] = null;
    if (msg) this.flashHint(msg);
  }

  applyTownDamage(seg, dmg){
    CONFIG.towns.forEach((t, idx) => {
      if (t.yIndex === seg && this.townAlive[idx]){
        this.townHP[idx] = Math.max(0, this.townHP[idx] - dmg);
        if (this.townHP[idx] <= 0){
          this.townAlive[idx] = false;
          this.score -= 120;
          this.flashHint(`${t.name} lost to the sea.`);
          this.townSprites[idx].setTint(0x666666);
        }
        this.updateTownText(idx);
      }
    });
  }

  updateTownText(idx){
    const t = CONFIG.towns[idx];
    const hp = Math.round(this.townHP[idx]);
    this.townText[idx].setText(`${t.name}\nHP: ${hp}`);
    this.townText[idx].setAlpha(this.townAlive[idx] ? 1 : 0.65);
  }

  syncUI(){
    budgetEl.textContent = money(this.budget);
    scoreEl.textContent = Math.max(0, Math.round(this.score)).toLocaleString("en-GB");
    stormEl.textContent = this.stormActive ? "Storm surge!" : "Calm";
  }

  checkGameOver(){
    const anyAlive = this.townAlive.some(v => v);
    if (!anyAlive && !this.gameOver){
      this.gameOver = true;
      this.endDebrief();
    }
  }

  endDebrief(){
    // simple explanation based on player choices
    let groynes = 0, hard = 0, soft = 0, retreat = 0;
    for (let i=0;i<CONFIG.segments;i++){
      const d = this.defences[i];
      if (!d) continue;
      if (d.type === "groyne") groynes++;
      if (d.type === "nourish") soft++;
      if (d.type === "retreat") retreat++;
      if (d.type === "seawall" || d.type === "rocks" || d.type === "groyne") hard++;
    }

    let msg = "";
    if (groynes >= 2){
      msg += "<p><strong>Down‑drift effect:</strong> You used several groynes. They trap sediment, which can starve beaches further south and increase erosion down‑drift.</p>";
    } else if (soft >= 2){
      msg += "<p><strong>Soft engineering:</strong> You relied on nourishment. It protects briefly, but needs repeat funding as waves remove material.</p>";
    } else if (retreat >= 1){
      msg += "<p><strong>Managed retreat:</strong> You accepted land loss in places to focus resources elsewhere. This can be the most sustainable option where erosion is rapid.</p>";
    } else {
      msg += "<p><strong>Balance:</strong> You tried a mix of approaches. In reality, the ‘best’ choice depends on costs, environment, and what’s at risk.</p>";
    }

    const quiz = `
      <h3>Quick KS3 check (self‑mark)</h3>
      <ol>
        <li>Name one erosion process that affects Holderness (e.g. hydraulic action, abrasion).</li>
        <li>Explain why groynes might increase erosion further south (down‑drift).</li>
        <li>Give one reason a council might choose managed retreat.</li>
      </ol>
      <p class="tiny">Use your answers to write 3–4 sentences explaining your strategy.</p>
    `;

    openModal("Game over: Debrief", `
      <p><strong>Final score:</strong> ${Math.max(0, Math.round(this.score)).toLocaleString("en-GB")}</p>
      ${msg}
      ${quiz}
      <p class="tiny"><strong>Teacher note:</strong> Ask pupils to point to where their groynes were placed and predict which towns were down‑drift.</p>
    `);
  }

  update(time, delta){
    if (this.gameOver) return;

    // Budget tick
    if (time - this.lastBudgetTick > 1000){
      this.budget += CONFIG.budgetPerSecond;
      this.lastBudgetTick = time;
      this.syncUI();
    }

    // Storm timing
    if (!this.stormActive && time >= this.nextStormAt){
      this.stormActive = true;
      this.stormEndsAt = time + CONFIG.stormDurationMs;
      this.nextStormAt = time + CONFIG.stormEveryMs;
      this.flashHint("Storm surge! Erosion increases.");
      this.cameras.main.shake(220, 0.006);
      this.syncUI();
    }
    if (this.stormActive && time >= this.stormEndsAt){
      this.stormActive = false;
      this.flashHint("Storm passes. Calm seas.");
      this.syncUI();
    }

    // Spawn waves
    const spawnRate = this.stormActive ? (CONFIG.waveSpawnMs / CONFIG.stormSpawnMultiplier) : CONFIG.waveSpawnMs;
    if (time - this.lastWaveSpawn > spawnRate){
      this.spawnWave();
      this.lastWaveSpawn = time;
    }

    // Move defence sprites with coastline retreat
    for (let i=0;i<CONFIG.segments;i++){
      if (this.defenceSprites[i]){
        this.defenceSprites[i].x = this.coast[i] + 22;
      }
    }

    // Move towns with coast retreat (towns sit on land side)
    CONFIG.towns.forEach((t, idx) => {
      const seg = t.yIndex;
      const baseX = this.coast[seg] - 44;
      this.townSprites[idx].x = baseX;
      this.townText[idx].x = baseX + 18;
      // if coastline retreats past the town -> heavy damage
      if (this.townAlive[idx] && this.coast[seg] < 110){
        this.townHP[idx] = Math.max(0, this.townHP[idx] - (this.stormActive ? 6 : 3));
        if (this.townHP[idx] <= 0){
          this.townAlive[idx] = false;
          this.flashHint(`${t.name} lost to the sea.`);
          this.townSprites[idx].setTint(0x666666);
        }
        this.updateTownText(idx);
      }
    });

    // Handle wave collisions with coastline
    this.waves.children.iterate((w) => {
      if (!w) return;
      const seg = w.getData("yIndex");
      if (w.x <= this.coast[seg] + 10){
        this.hitCoast(w);
        w.destroy();
      } else if (w.x < -60){
        w.destroy();
      }
    });

    // Game over?
    this.checkGameOver();
  }
}

function startGame(){
  const config = {
    type: Phaser.AUTO,
    width: CONFIG.width,
    height: CONFIG.height,
    parent: "game",
    physics: { default: "arcade", arcade: { debug: false } },
    scene: [MainScene],
    backgroundColor: "#0b1220",
  };
  phaserGame = new Phaser.Game(config);

  // Default selection
  const first = document.querySelector(".tool[data-tool='rocks']");
  if (first){
    first.click();
  }
}
startGame();
