import type * as Party from "partykit/server";

type Suit = "H" | "D" | "C" | "S";

interface Card {
  suit: Suit;
  rank: number; // 1=Ace, 2-10, 11=J, 12=Q, 13=K
  id: string;
}

interface Meld {
  id: string;
  type: "set" | "run";
  cards: Card[];
}

interface RoundState {
  hands: Record<string, Card[]>;
  stock: Card[];
  discardPile: Card[];
  melds: Meld[];
  currentTurn: string;
  turnPhase: "draw" | "action" | "discard";
  drawnFromDiscardId: string | null;
  hasMeldedThisTurn: boolean;
  stockExhaustedCount: number;
  dealerIndex: number;
}

interface GameOptions {
  mode: "points" | "single";
  pointsTarget: number;
  tasRules: boolean;
}

interface GameState {
  phase: "waiting" | "options" | "playing" | "round_over" | "finished";
  scores: Record<string, number>;
  round: RoundState | null;
  winner: string | null;
  connections: Record<string, string>; // playerName -> connectionId
  roundNumber: number;
  lastRoundSummary: { winner: string | null; points: number; isDraw: boolean } | null;
  options: GameOptions;
}

const PLAYERS = ["Tas", "Steve"] as const;
const DEFAULT_OPTIONS: GameOptions = { mode: "single", pointsTarget: 50, tasRules: false };
const ROUND_OVER_DELAY_MS = 5000;

const RECONNECT_GRACE_MS = 60_000;

export default class RummyServer implements Party.Server {
  private state: GameState;
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(readonly room: Party.Room) {
    this.state = {
      phase: "waiting",
      scores: { Tas: 0, Steve: 0 },
      round: null,
      winner: null,
      connections: {},
      roundNumber: 0,
      lastRoundSummary: null,
      options: { ...DEFAULT_OPTIONS },
    };
  }

  onConnect(conn: Party.Connection) {
    conn.send(JSON.stringify({ type: "state", state: this.viewFor(conn.id) }));
  }

  onClose(conn: Party.Connection) {
    const player = this.playerFor(conn.id);
    if (!player) return;

    delete this.state.connections[player];

    if (
      this.state.phase === "playing" ||
      this.state.phase === "round_over" ||
      this.state.phase === "options"
    ) {
      // Give the player time to reconnect (e.g. after iOS app-switch) before ending the game
      const timer = setTimeout(() => {
        this.disconnectTimers.delete(player);
        if (!this.state.connections[player]) {
          for (const c of this.room.getConnections()) {
            c.send(JSON.stringify({ type: "opponent_disconnected" }));
          }
          this.state.phase = "waiting";
          this.state.round = null;
          this.state.lastRoundSummary = null;
          this.broadcast();
        }
      }, RECONNECT_GRACE_MS);

      this.disconnectTimers.set(player, timer);

      for (const c of this.room.getConnections()) {
        c.send(JSON.stringify({ type: "reconnecting", player }));
      }
    }

    this.broadcast();
  }

  onMessage(message: string | ArrayBuffer, sender: Party.Connection) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message as string);
    } catch {
      return;
    }
    const player = this.playerFor(sender.id);

    switch (msg.type) {
      case "join":
        return this.handleJoin(sender, msg.player as string);
      case "draw":
        return this.handleDraw(sender, player, msg.from as "stock" | "discard");
      case "meld":
        return this.handleMeld(sender, player, msg.cardIds as string[]);
      case "layoff":
        return this.handleLayoff(sender, player, msg.cardIds as string[], msg.meldId as string);
      case "done_action":
        return this.handleDoneAction(sender, player);
      case "discard":
        return this.handleDiscard(sender, player, msg.cardId as string);
      case "ping":
        return; // keep-alive — no response needed
      case "set_options":
        return this.handleSetOptions(sender, player, msg.options as Partial<GameOptions>);
      case "begin_game":
        return this.handleBeginGame(player);
      case "reset":
        return this.handleReset(sender, player);
      case "end_game":
        return this.handleEndGame();
    }
  }

  // --- Handlers ---

  private handleJoin(conn: Party.Connection, playerName: string) {
    if (!(PLAYERS as readonly string[]).includes(playerName)) {
      return conn.send(JSON.stringify({ type: "error", message: "Invalid player name" }));
    }

    const existingId = this.state.connections[playerName];
    if (existingId && existingId !== conn.id) {
      return conn.send(JSON.stringify({ type: "error", message: "That avatar is already taken" }));
    }

    const previousPlayer = this.playerFor(conn.id);
    if (previousPlayer && previousPlayer !== playerName) {
      delete this.state.connections[previousPlayer];
    }

    // Cancel any pending disconnect timer — player has reconnected in time
    const timer = this.disconnectTimers.get(playerName);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.disconnectTimers.delete(playerName);
      for (const c of this.room.getConnections()) {
        c.send(JSON.stringify({ type: "reconnected", player: playerName }));
      }
    }

    this.state.connections[playerName] = conn.id;
    this.broadcast();
    this.checkAutoStart();
  }

  private handleDraw(conn: Party.Connection, player: string | null, from: "stock" | "discard") {
    if (!player || !this.state.round) return;
    const r = this.state.round;

    if (r.currentTurn !== player || r.turnPhase !== "draw") {
      return conn.send(JSON.stringify({ type: "error", message: "Not your turn to draw" }));
    }

    let card: Card;

    if (from === "discard") {
      if (r.discardPile.length === 0) {
        return conn.send(JSON.stringify({ type: "error", message: "Discard pile is empty" }));
      }
      card = r.discardPile.pop()!;
      r.drawnFromDiscardId = card.id;
    } else {
      if (r.stock.length === 0) {
        r.stockExhaustedCount++;
        if (r.stockExhaustedCount >= 2 || r.discardPile.length <= 1) {
          return this.endRoundDraw();
        }
        const top = r.discardPile.pop()!;
        r.stock = this.shuffle([...r.discardPile]);
        r.discardPile = [top];
      }
      card = r.stock.pop()!;
      r.drawnFromDiscardId = null;
    }

    r.hands[player].push(card);
    r.turnPhase = "action";
    r.hasMeldedThisTurn = false;
    this.broadcast();
  }

  private handleMeld(conn: Party.Connection, player: string | null, cardIds: string[]) {
    if (!player || !this.state.round) return;
    const r = this.state.round;

    if (r.currentTurn !== player || r.turnPhase !== "action") {
      return conn.send(JSON.stringify({ type: "error", message: "Cannot meld now" }));
    }

    const cards = this.pickFromHand(r.hands[player], cardIds);
    if (!cards || cards.length < 3) {
      return conn.send(JSON.stringify({ type: "error", message: "Need at least 3 cards to meld" }));
    }

    const meldType = this.validateMeld(cards);
    if (!meldType) {
      return conn.send(JSON.stringify({ type: "error", message: "Invalid meld — must be a set (3-4 same rank) or run (3+ consecutive same suit)" }));
    }
    if (this.state.options.tasRules && meldType === "set") {
      return conn.send(JSON.stringify({ type: "error", message: "Tas Rules: sets are not allowed — runs only!" }));
    }

    r.hands[player] = r.hands[player].filter((c) => !cardIds.includes(c.id));
    r.melds.push({ id: `m${Date.now()}${Math.random().toString(36).slice(2)}`, type: meldType, cards });
    r.hasMeldedThisTurn = true;

    if (r.hands[player].length === 0) return this.playerGoesOut(player);
    this.broadcast();
  }

  private handleLayoff(conn: Party.Connection, player: string | null, cardIds: string[], meldId: string) {
    if (!player || !this.state.round) return;
    const r = this.state.round;

    if (r.currentTurn !== player || r.turnPhase !== "action") {
      return conn.send(JSON.stringify({ type: "error", message: "Cannot lay off now" }));
    }

    const meld = r.melds.find((m) => m.id === meldId);
    if (!meld) {
      return conn.send(JSON.stringify({ type: "error", message: "Meld not found" }));
    }

    const cards = this.pickFromHand(r.hands[player], cardIds);
    if (!cards || cards.length === 0) {
      return conn.send(JSON.stringify({ type: "error", message: "Cards not in hand" }));
    }

    const combined = [...meld.cards, ...cards];
    const meldType = this.validateMeld(combined);
    if (!meldType) {
      return conn.send(JSON.stringify({ type: "error", message: "Invalid lay off — cards don't extend that meld" }));
    }

    r.hands[player] = r.hands[player].filter((c) => !cardIds.includes(c.id));
    meld.cards = combined;
    meld.type = meldType;

    if (r.hands[player].length === 0) return this.playerGoesOut(player);
    this.broadcast();
  }

  private handleDoneAction(conn: Party.Connection, player: string | null) {
    if (!player || !this.state.round) return;
    const r = this.state.round;

    if (r.currentTurn !== player || r.turnPhase !== "action") {
      return conn.send(JSON.stringify({ type: "error", message: "Not in action phase" }));
    }
    if (this.state.options.tasRules && this.runMeldCapacity(r.hands[player]) >= 2) {
      return conn.send(JSON.stringify({ type: "error", message: "Tas Rules: you have multiple melds in hand — play one before proceeding!" }));
    }
    r.turnPhase = "discard";
    this.broadcast();
  }

  private handleDiscard(conn: Party.Connection, player: string | null, cardId: string) {
    if (!player || !this.state.round) return;
    const r = this.state.round;

    if (r.currentTurn !== player || r.turnPhase !== "discard") {
      return conn.send(JSON.stringify({ type: "error", message: "Not your turn to discard" }));
    }

    if (cardId === r.drawnFromDiscardId) {
      return conn.send(JSON.stringify({ type: "error", message: "Cannot discard the card you just drew from the discard pile" }));
    }

    const idx = r.hands[player].findIndex((c) => c.id === cardId);
    if (idx === -1) {
      return conn.send(JSON.stringify({ type: "error", message: "Card not in hand" }));
    }

    const [card] = r.hands[player].splice(idx, 1);
    r.discardPile.push(card);
    r.drawnFromDiscardId = null;

    if (r.hands[player].length === 0) return this.playerGoesOut(player);

    const next = PLAYERS.find((n) => n !== player)!;
    r.currentTurn = next;
    r.turnPhase = "draw";
    r.hasMeldedThisTurn = false;
    this.broadcast();
  }

  private handleSetOptions(conn: Party.Connection, player: string | null, options: Partial<GameOptions>) {
    if (!player || this.state.phase !== "options") return;
    if (options.mode === "points" || options.mode === "single") {
      this.state.options.mode = options.mode;
    }
    if (options.pointsTarget !== undefined) {
      this.state.options.pointsTarget = Math.max(1, Math.min(200, Math.round(options.pointsTarget)));
    }
    if (typeof options.tasRules === "boolean") {
      this.state.options.tasRules = options.tasRules;
    }
    this.broadcast();
  }

  private handleBeginGame(player: string | null) {
    if (!player || this.state.phase !== "options") return;
    if (Object.keys(this.state.connections).length < 2) return;
    this.startRound();
  }

  // --- Game logic ---

  private checkAutoStart() {
    const connected = Object.keys(this.state.connections).length;
    if (connected === 2 && this.state.phase === "waiting") {
      this.state.phase = "options";
      this.broadcast();
    }
  }

  private startRound() {
    const deck = this.shuffle(this.createDeck());
    const dealerIdx = this.state.roundNumber % 2;
    const goesFirst = PLAYERS[(dealerIdx + 1) % 2];

    const hands: Record<string, Card[]> = {};
    let i = 0;
    for (const name of PLAYERS) {
      hands[name] = deck.slice(i, i + 10);
      i += 10;
    }

    const remaining = deck.slice(i);
    const firstDiscard = remaining.pop()!;

    this.state.round = {
      hands,
      stock: remaining,
      discardPile: [firstDiscard],
      melds: [],
      currentTurn: goesFirst,
      turnPhase: "draw",
      drawnFromDiscardId: null,
      hasMeldedThisTurn: false,
      stockExhaustedCount: 0,
      dealerIndex: dealerIdx,
    };
    this.state.phase = "playing";
    this.state.roundNumber++;
    this.state.lastRoundSummary = null;
    this.broadcast();
  }

  private playerGoesOut(player: string) {
    const r = this.state.round!;
    const opponent = PLAYERS.find((n) => n !== player)!;
    const points = r.hands[opponent].reduce((s, c) => s + this.cardValue(c), 0);

    this.state.scores[player] += points;
    this.state.lastRoundSummary = { winner: player, points, isDraw: false };

    const gameOver =
      this.state.options.mode === "single" ||
      this.state.scores[player] >= this.state.options.pointsTarget;

    if (gameOver) {
      this.state.winner = player;
      this.state.phase = "finished";
      this.broadcast();
    } else {
      this.state.phase = "round_over";
      this.broadcast();
      setTimeout(() => {
        if (this.state.phase === "round_over") {
          this.startRound();
        }
      }, ROUND_OVER_DELAY_MS);
    }
  }

  private endRoundDraw() {
    this.state.lastRoundSummary = { winner: null, points: 0, isDraw: true };
    this.state.phase = "round_over";
    this.broadcast();
    setTimeout(() => {
      if (this.state.phase === "round_over") {
        this.startRound();
      }
    }, ROUND_OVER_DELAY_MS);
  }

  private handleEndGame() {
    for (const c of this.room.getConnections()) {
      c.send(JSON.stringify({ type: "end_game" }));
    }
    this.state = {
      phase: "waiting",
      scores: { Tas: 0, Steve: 0 },
      round: null,
      winner: null,
      connections: {},
      roundNumber: 0,
      lastRoundSummary: null,
      options: { ...DEFAULT_OPTIONS },
    };
  }

  private handleReset(conn: Party.Connection, player: string | null) {
    if (!player) return;
    this.state = {
      phase: "waiting",
      scores: { Tas: 0, Steve: 0 },
      round: null,
      winner: null,
      connections: this.state.connections,
      roundNumber: 0,
      lastRoundSummary: null,
      options: { ...this.state.options }, // preserve options from previous game
    };
    this.broadcast();
    this.checkAutoStart();
  }

  // --- Validation ---

  // Returns the number of non-overlapping runs of 3+ that can be formed from the hand.
  // Used by Tas Rules to detect when a player holds multiple melds.
  private runMeldCapacity(hand: Card[]): number {
    const bySuit: Record<string, number[]> = {};
    for (const card of hand) {
      (bySuit[card.suit] ??= []).push(card.rank);
    }
    let capacity = 0;
    for (const ranks of Object.values(bySuit)) {
      ranks.sort((a, b) => a - b);
      let seqLen = 1;
      for (let i = 1; i <= ranks.length; i++) {
        if (i < ranks.length && ranks[i] === ranks[i - 1] + 1) {
          seqLen++;
        } else {
          capacity += Math.floor(seqLen / 3);
          seqLen = 1;
        }
      }
    }
    return capacity;
  }

  private validateMeld(cards: Card[]): "set" | "run" | null {
    if (cards.length < 3) return null;
    if (this.isSet(cards)) return "set";
    if (this.isRun(cards)) return "run";
    return null;
  }

  private isSet(cards: Card[]): boolean {
    if (cards.length < 3 || cards.length > 4) return false;
    const rank = cards[0].rank;
    const suits = new Set(cards.map((c) => c.suit));
    return cards.every((c) => c.rank === rank) && suits.size === cards.length;
  }

  private isRun(cards: Card[]): boolean {
    if (cards.length < 3) return false;
    const suit = cards[0].suit;
    if (!cards.every((c) => c.suit === suit)) return false;
    const ranks = cards.map((c) => c.rank).sort((a, b) => a - b);
    for (let i = 1; i < ranks.length; i++) {
      if (ranks[i] !== ranks[i - 1] + 1) return false;
    }
    return true;
  }

  private cardValue(card: Card): number {
    if (card.rank === 1) return 1;
    if (card.rank >= 11) return 10;
    return card.rank;
  }

  // --- Utilities ---

  private playerFor(connId: string): string | null {
    return Object.entries(this.state.connections).find(([, id]) => id === connId)?.[0] ?? null;
  }

  private pickFromHand(hand: Card[], ids: string[]): Card[] | null {
    if (new Set(ids).size !== ids.length) return null;
    const result: Card[] = [];
    for (const id of ids) {
      const c = hand.find((h) => h.id === id);
      if (!c) return null;
      result.push(c);
    }
    return result;
  }

  private viewFor(connId: string): Record<string, unknown> {
    const player = this.playerFor(connId);
    const { phase, scores, winner, roundNumber, round, lastRoundSummary, options } = this.state;
    const connectedPlayers = Object.keys(this.state.connections);

    const base: Record<string, unknown> = {
      phase,
      scores,
      winner,
      roundNumber,
      connectedPlayers,
      myName: player,
      lastRoundSummary,
      options,
    };

    if (!round || !player) return base;

    const opponent = PLAYERS.find((n) => n !== player)!;
    return {
      ...base,
      turnPhase: round.turnPhase,
      currentTurn: round.currentTurn,
      myHand: round.hands[player] ?? [],
      opponentHandCount: (round.hands[opponent] ?? []).length,
      stockCount: round.stock.length,
      discardPile: round.discardPile,
      melds: round.melds,
      drawnFromDiscardId: round.currentTurn === player ? round.drawnFromDiscardId : null,
      hasMeldedThisTurn: round.hasMeldedThisTurn,
    };
  }

  private broadcast() {
    for (const conn of this.room.getConnections()) {
      conn.send(JSON.stringify({ type: "state", state: this.viewFor(conn.id) }));
    }
  }

  private createDeck(): Card[] {
    const cards: Card[] = [];
    for (const suit of ["H", "D", "C", "S"] as Suit[]) {
      for (let rank = 1; rank <= 13; rank++) {
        cards.push({ suit, rank, id: `${suit}${rank}` });
      }
    }
    return cards;
  }

  private shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}
