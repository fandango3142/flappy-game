"use strict";
/**
 * Flappy Shopper Game
 *
 * This TypeScript implementation builds a simple Flappy‑Bird‑style game where
 * the player controls a sassy shopper wearing sunglasses. The shopper must
 * navigate through waves of rushing crowds during a sale without colliding.
 * The game awards increasing discounts based on the final score and
 * maintains a local top‑3 scoreboard. After each play, users are prompted
 * for their details before redeeming rewards or playing again. A maximum
 * number of plays is enforced. The game communicates with its parent
 * container (for example, a WebEngage in‑app message) via postMessage to
 * resize its iframe and emit analytics events.
 */
/** Mapping from score ranges to reward discounts (percent). */
const REWARD_THRESHOLDS = [
    { min: 0, max: 9, discount: 5 },
    { min: 10, max: 19, discount: 10 },
    { min: 20, max: 29, discount: 15 },
    { min: 30, max: Infinity, discount: 20 },
];
class FlappyShopperGame {
    constructor(canvas, overlay, shopperImg, obstacleImg) {
        this.lastTimestamp = 0;
        this.spawnTimer = 0;
        this.baseSpawnInterval = 2000;
        this.obstacles = [];
        this.score = 0;
        this.lives = 3;
        this.playing = false;
        this.config = { theme: "default", maxSpins: 3 };
        this.playCount = 0;
        this.maxPlays = 3;
        this.scoreboard = [];
        this.detailsCaptured = false;
        this.parentOrigin = "*";
        this.randomCode = "";
        this.canvas = canvas;
        const ctx = canvas.getContext("2d");
        if (!ctx)
            throw new Error("Canvas 2D context not available");
        this.ctx = ctx;
        this.overlay = overlay;
        this.shopperImg = shopperImg;
        this.obstacleImg = obstacleImg;
        // initialise player with dummy values; actual dimensions set in init()
        this.player = { x: 0, y: 0, width: 40, height: 40, vy: 0 };
        // Bind event handlers
        this.handleKeyPress = this.handleKeyPress.bind(this);
        this.handleTouch = this.handleTouch.bind(this);
        // Load persisted values
        this.loadState();
    }
    /**
     * Load saved scoreboard, play count and user details from localStorage.
     */
    loadState() {
        try {
            const sb = localStorage.getItem("flappyShopperScoreboard");
            if (sb) {
                this.scoreboard = JSON.parse(sb);
            }
        }
        catch (_) {
            this.scoreboard = [];
        }
        try {
            const pc = localStorage.getItem("flappyShopperPlayCount");
            if (pc) {
                this.playCount = parseInt(pc, 10) || 0;
            }
        }
        catch (_) {
            this.playCount = 0;
        }
        try {
            const details = localStorage.getItem("flappyShopperDetails");
            if (details) {
                this.detailsCaptured = true;
            }
        }
        catch (_) {
            this.detailsCaptured = false;
        }
    }
    /**
     * Persist scoreboard and play count to localStorage.
     */
    saveState() {
        try {
            localStorage.setItem("flappyShopperScoreboard", JSON.stringify(this.scoreboard));
        }
        catch (_) {
            /* ignore */
        }
        try {
            localStorage.setItem("flappyShopperPlayCount", this.playCount.toString());
        }
        catch (_) {
            /* ignore */
        }
    }
    /**
     * Resize the canvas to maintain aspect ratio and full width of its container.
     */
    resizeCanvas() {
        const container = this.canvas.parentElement;
        if (container) {
            const width = container.clientWidth;
            // Maintain a 9:16 (portrait) ratio commonly used in mobile games.
            const height = Math.floor((width * 16) / 9);
            this.canvas.width = width;
            this.canvas.height = height;
            // Update player position relative to new dimensions
            this.player.x = width * 0.2;
            this.player.y = height * 0.5;
            this.player.width = width * 0.1;
            this.player.height = width * 0.1;
            // Update any existing obstacles sizes proportionally
            this.obstacles.forEach((o) => {
                o.width = width * 0.12;
                o.height = width * 0.18;
            });
            this.sendHeight();
        }
    }
    /**
     * Initialise the game and attach event listeners. Should be called once after
     * images are loaded.
     */
    init(config) {
        // Merge configuration
        this.config = Object.assign(Object.assign({}, this.config), config);
        if (typeof this.config.maxSpins === "number") {
            this.maxPlays = this.config.maxSpins;
        }
        if (this.config.parentOrigin) {
            this.parentOrigin = this.config.parentOrigin;
        }
        // initial canvas sizing
        this.resizeCanvas();
        window.addEventListener("resize", () => this.resizeCanvas());
        // input events
        window.addEventListener("keydown", this.handleKeyPress);
        this.canvas.addEventListener("click", this.handleTouch);
        this.canvas.addEventListener("touchstart", this.handleTouch);
        // Immediately send a height so the parent can size the iframe correctly.
        this.sendHeight();
        // If user has remaining plays, show start overlay; otherwise show out-of-plays message.
        if (this.playCount >= this.maxPlays) {
            this.showNoPlaysLeft();
        }
        else {
            this.showStartScreen();
        }
    }
    /** Handle keyboard controls. */
    handleKeyPress(e) {
        if (e.code === "Space" || e.code === "ArrowUp") {
            e.preventDefault();
            if (this.playing) {
                this.jump();
            }
        }
    }
    /** Handle click or touch controls. */
    handleTouch(e) {
        e.preventDefault();
        if (this.playing) {
            this.jump();
        }
    }
    /** Apply a jump (upward velocity) to the player. */
    jump() {
        // only apply jump if still alive
        this.player.vy = -0.35 * this.canvas.height; // proportional to canvas height
    }
    /**
     * Begin a new game session. Resets lives, score, obstacles and starts the
     * animation loop. Increments the play counter.
     */
    startGame() {
        this.score = 0;
        this.lives = 3;
        this.obstacles = [];
        this.player.vy = 0;
        // Place player in vertical centre
        this.player.y = this.canvas.height * 0.5;
        this.spawnTimer = 0;
        this.lastTimestamp = performance.now();
        this.playing = true;
        // increment play count
        this.playCount++;
        this.saveState();
        // hide any overlay
        this.hideOverlay();
        // send event to parent
        this.emitEvent("started", { userId: this.config.userId, play: this.playCount });
        // start loop
        this.frameRequest = requestAnimationFrame((t) => this.gameLoop(t));
    }
    /**
     * Main game loop. Calculates delta time, updates logic and renders the frame.
     */
    gameLoop(timestamp) {
        const dt = timestamp - this.lastTimestamp;
        this.lastTimestamp = timestamp;
        if (this.playing) {
            this.update(dt);
            this.draw();
            this.frameRequest = requestAnimationFrame((t) => this.gameLoop(t));
        }
    }
    /** Update game state. */
    update(dt) {
        const dtSeconds = dt / 1000;
        const gravity = 1.2 * this.canvas.height; // gravitational acceleration relative to canvas
        // Apply gravity to player
        this.player.vy += gravity * dtSeconds;
        this.player.y += this.player.vy * dtSeconds;
        // Prevent player from leaving the top or bottom
        if (this.player.y < 0) {
            this.player.y = 0;
            this.player.vy = 0;
        }
        if (this.player.y + this.player.height > this.canvas.height) {
            this.player.y = this.canvas.height - this.player.height;
            this.player.vy = 0;
        }
        // Update obstacles
        const speed = (this.canvas.width * 0.3) + (this.score * this.canvas.width * 0.01);
        this.obstacles.forEach((obs) => {
            obs.x -= speed * dtSeconds;
            // Mark score when passed
            if (!obs.passed && obs.x + obs.width < this.player.x) {
                obs.passed = true;
                this.score++;
                this.emitEvent("score", { score: this.score });
            }
        });
        // Remove off‑screen obstacles
        this.obstacles = this.obstacles.filter((obs) => obs.x + obs.width > 0);
        // Spawn new obstacles
        this.spawnTimer += dt;
        // spawn interval decreases as score increases to raise difficulty
        const interval = Math.max(this.baseSpawnInterval - this.score * 50, 900);
        if (this.spawnTimer >= interval) {
            this.spawnTimer = 0;
            this.spawnObstacle();
        }
        // Collision detection
        for (const obs of this.obstacles) {
            if (this.checkCollision(obs)) {
                // Collided: lose a life and reset position
                this.lives--;
                this.emitEvent("collision", { remainingLives: this.lives });
                if (this.lives > 0) {
                    // Reset player position
                    this.player.y = this.canvas.height * 0.5;
                    this.player.vy = 0;
                    // Remove collided obstacle to avoid repeated collisions
                    obs.x = -obs.width;
                }
                else {
                    // Game over
                    this.playing = false;
                    cancelAnimationFrame(this.frameRequest);
                    this.endGame();
                    return;
                }
            }
        }
    }
    /** Draw the current frame. */
    draw() {
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        // Clear canvas
        ctx.clearRect(0, 0, w, h);
        // Background (simple coloured rectangles to evoke a busy mall)
        ctx.fillStyle = "#ffe08a";
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#ffd36b";
        ctx.fillRect(0, h * 0.7, w, h * 0.3);
        // Draw obstacles (crowds)
        for (const obs of this.obstacles) {
            ctx.drawImage(this.obstacleImg, obs.x, obs.y, obs.width, obs.height);
        }
        // Draw player (shopper)
        ctx.drawImage(this.shopperImg, this.player.x, this.player.y, this.player.width, this.player.height);
        // Draw score and lives
        ctx.fillStyle = "#000";
        ctx.font = `${Math.floor(w * 0.05)}px sans-serif`;
        ctx.fillText(`Score: ${this.score}`, 10, 30);
        ctx.fillText(`Lives: ${this.lives}`, 10, 30 + w * 0.06);
    }
    /** Spawn a new obstacle at a random vertical position. */
    spawnObstacle() {
        const w = this.canvas.width;
        const h = this.canvas.height;
        const obsWidth = w * 0.12;
        const obsHeight = w * 0.18;
        const y = Math.random() * (h - obsHeight);
        this.obstacles.push({
            x: w,
            y,
            width: obsWidth,
            height: obsHeight,
            passed: false,
        });
    }
    /** Check axis‑aligned bounding box collision between player and obstacle. */
    checkCollision(obs) {
        return (this.player.x < obs.x + obs.width &&
            this.player.x + this.player.width > obs.x &&
            this.player.y < obs.y + obs.height &&
            this.player.y + this.player.height > obs.y);
    }
    /** End the game: update scoreboard, compute reward and display UI. */
    endGame() {
        // Update scoreboard
        this.scoreboard.push(this.score);
        this.scoreboard.sort((a, b) => b - a);
        if (this.scoreboard.length > 3) {
            this.scoreboard = this.scoreboard.slice(0, 3);
        }
        this.saveState();
        // Compute reward
        const reward = this.computeReward();
        // Generate random code for discount
        this.randomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        // Display overlay
        this.showGameOverUI(reward);
        // Emit game over event
        this.emitEvent("game_over", { score: this.score, reward: reward.discount });
    }
    /** Determine discount based on final score. */
    computeReward() {
        for (const r of REWARD_THRESHOLDS) {
            if (this.score >= r.min && this.score <= r.max) {
                return { discount: r.discount, message: `${r.discount}% off` };
            }
        }
        return { discount: 5, message: "5% off" };
    }
    /** Show overlay at the start of the game. */
    showStartScreen() {
        const html = `
      <h2 style="margin: 0 0 16px 0; text-align:center;">Flappy Shopper</h2>
      <p style="text-align:center; margin-bottom:16px;">Navigate through the crowds and rack up points! You have <strong>${this.maxPlays - this.playCount}</strong> play(s) remaining.</p>
      <button class="button" id="startBtn">Start Game</button>
    `;
        this.showOverlay(html);
        const startBtn = document.getElementById("startBtn");
        if (startBtn) {
            startBtn.addEventListener("click", () => {
                this.startGame();
            });
        }
    }
    /** Show overlay when no plays remain. */
    showNoPlaysLeft() {
        const html = `
      <h2 style="margin:0 0 16px 0; text-align:center;">No more plays</h2>
      <p style="text-align:center;">You've reached the maximum number of plays for this promotion. Thank you for participating!</p>
    `;
        this.showOverlay(html);
    }
    /** Display the game over UI with scoreboard, rewards and actions. */
    showGameOverUI(reward) {
        // Build scoreboard table rows
        let tableRows = "";
        const prizes = [
            "Shopping worth $10K",
            "Shopping worth $5K",
            "Shopping worth $2K",
        ];
        for (let i = 0; i < 3; i++) {
            const score = this.scoreboard[i] !== undefined ? this.scoreboard[i] : "-";
            const prize = prizes[i];
            tableRows += `<tr><td>${i + 1}</td><td>${score}</td><td>${prize}</td></tr>`;
        }
        const html = `
      <h2 style="margin:0 0 8px 0; text-align:center;">Game Over</h2>
      <p style="text-align:center; margin:4px 0;">Your score: <strong>${this.score}</strong></p>
      <p style="text-align:center; margin:4px 0;">Your reward: <strong>${reward.message}</strong> (Code: <strong>${this.randomCode}</strong>)</p>
      <div class="scoreboard">
        <h3 style="margin:8px 0;">Top Scores</h3>
        <table>
          <thead><tr><th>#</th><th>Score</th><th>Prize</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      <div style="margin-top:16px; display:flex; flex-direction:column; align-items:center;">
        <button class="button" id="redeemBtn">Redeem Reward</button>
        <button class="button" id="playAgainBtn" ${this.playCount >= this.maxPlays ? "disabled" : ""}>Play Again</button>
      </div>
    `;
        this.showOverlay(html);
        // attach actions
        const redeemBtn = document.getElementById("redeemBtn");
        if (redeemBtn) {
            redeemBtn.addEventListener("click", () => {
                this.handleAction("redeem");
            });
        }
        const playAgainBtn = document.getElementById("playAgainBtn");
        if (playAgainBtn) {
            playAgainBtn.addEventListener("click", () => {
                this.handleAction("playAgain");
            });
        }
    }
    /** Handle user actions from the game over screen. */
    handleAction(action) {
        // If details already captured, either redeem or play again directly
        if (this.detailsCaptured) {
            if (action === "redeem") {
                // Show redeem confirmation
                const html = `
          <h2 style="margin:0 0 16px 0; text-align:center;">Reward Redeemed!</h2>
          <p style="text-align:center;">Thank you, <strong>${this.getDetail("name") || "shopper"}</strong>! Your discount code <strong>${this.randomCode}</strong> has been recorded. Enjoy your shopping!</p>
        `;
                this.showOverlay(html);
                this.emitEvent("redeem", { code: this.randomCode });
            }
            else if (action === "playAgain") {
                if (this.playCount < this.maxPlays) {
                    this.emitEvent("play_again", {});
                    this.startGame();
                }
                else {
                    this.showNoPlaysLeft();
                }
            }
        }
        else {
            // Show form to collect details first
            this.showDetailsForm(action);
        }
    }
    /** Render a details form to capture user information. */
    showDetailsForm(actionToContinue) {
        const html = `
      <h2 style="margin:0 8px 8px 0; text-align:center;">Tell us about you</h2>
      <p style="text-align:center; margin-bottom:8px;">We need your details to process the reward.</p>
      <div class="input-group"><label for="nameInput">Name</label><input id="nameInput" type="text" required /></div>
      <div class="input-group"><label for="emailInput">Email</label><input id="emailInput" type="email" required /></div>
      <div class="input-group"><label for="phoneInput">Phone</label><input id="phoneInput" type="tel" required /></div>
      <button class="button" id="submitDetailsBtn">Submit</button>
    `;
        this.showOverlay(html);
        const submitBtn = document.getElementById("submitDetailsBtn");
        if (submitBtn) {
            submitBtn.addEventListener("click", () => {
                const nameInput = document.getElementById("nameInput").value.trim();
                const emailInput = document.getElementById("emailInput").value.trim();
                const phoneInput = document.getElementById("phoneInput").value.trim();
                if (!nameInput || !emailInput || !phoneInput) {
                    alert("Please fill in all fields.");
                    return;
                }
                const details = { name: nameInput, email: emailInput, phone: phoneInput };
                try {
                    localStorage.setItem("flappyShopperDetails", JSON.stringify(details));
                }
                catch (_) {
                    /* ignore */
                }
                this.detailsCaptured = true;
                this.emitEvent("details_submitted", details);
                // Continue the original action
                this.handleAction(actionToContinue);
            });
        }
    }
    /** Retrieve a particular detail from saved user info. */
    getDetail(key) {
        try {
            const raw = localStorage.getItem("flappyShopperDetails");
            if (raw) {
                const obj = JSON.parse(raw);
                return obj[key];
            }
        }
        catch (_) {
            return undefined;
        }
        return undefined;
    }
    /** Utility to display overlay content. */
    showOverlay(html) {
        this.overlay.innerHTML = html;
        this.overlay.classList.add("visible");
        this.sendHeight();
    }
    /** Hide the overlay. */
    hideOverlay() {
        this.overlay.innerHTML = "";
        this.overlay.classList.remove("visible");
        this.sendHeight();
    }
    /** Post a message to the parent with the game container height for iframe resizing. */
    sendHeight() {
        var _a;
        const height = ((_a = this.canvas.parentElement) === null || _a === void 0 ? void 0 : _a.getBoundingClientRect().height) || this.canvas.height;
        try {
            parent.postMessage({ type: "we:game:height", px: height }, this.parentOrigin);
        }
        catch (_) {
            // no-op
        }
    }
    /** Emit an arbitrary event to the parent for analytics. */
    emitEvent(name, payload) {
        try {
            parent.postMessage({ type: "we:game:event", payload: Object.assign({ name }, payload) }, this.parentOrigin);
        }
        catch (_) {
            // no-op
        }
    }
}
// Bootstrapping: wait for DOM to be ready and images to load before creating the game.
window.addEventListener("DOMContentLoaded", () => {
    const canvas = document.getElementById("gameCanvas");
    const overlay = document.getElementById("overlay");
    // Preload assets
    const shopperImg = new Image();
    shopperImg.src = "./assets/shopper.png";
    const obstacleImg = new Image();
    obstacleImg.src = "./assets/obstacle.png";
    let loaded = 0;
    const onAssetLoaded = () => {
        loaded++;
        if (loaded === 2) {
            const game = new FlappyShopperGame(canvas, overlay, shopperImg, obstacleImg);
            // Initialise immediately with default configuration
            game.init();
            // Listen for configuration messages from parent
            window.addEventListener("message", (e) => {
                const data = e.data;
                if (data && data.type === "we:game:config") {
                    const config = data.payload || {};
                    // Reinitialise the game with new config. This call is idempotent.
                    game.init(config);
                }
            });
        }
    };
    shopperImg.onload = onAssetLoaded;
    obstacleImg.onload = onAssetLoaded;
});
