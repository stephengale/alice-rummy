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

interface GameState {
  phase: "waiting" | "playing" | "round_over" | "finished";
  scores: Record<string, number>;
  round: RoundState | null;
  winner: string | null;
  connections: Record<string, string>; // playerName -> connectionId
  roundNumber: number;
  lastRoundSummary: { winner: string | null; points: number; isDraw: boolean } | null;
}

const PLAYERS = ["Tas", "Steve"] as const;
const WIN_SCORE = 100;
const ROUND_OVER_DELAY_MS = 5000;

export default class RummyServer implements Party.Server {
  private state: GameState;
  private autoStartScheduled = false;

  constructor(readonly room: Party.Room) {
    this.state = {
      phase: "waiting",
      scores: { Tas: 0, Steve: 0 },
      round: null,
      winner: null,
      connections: {},
      roundNumber: 0,
      lastRoundSummary: null,
    };
  }

  onConnect(conn: Party.Connection) {
    conn.send(JSON.stringify({ type: "state", state: this.viewFor(conn.id) }));
  }

  onClose(conn: Party.Connection) {
    const player = this.playerFor(conn.id);
    if (player) {
      delete this.state.connections[player];
      this.broadcast();
    }
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
    }
  }

  // --- Handlers ---

  private handleJoin(conn: Party.Connection, playerName: string) {
    if (!(PLAYERS as readonly string[]).includes(playerName)) {
      return conn.send(JSON.stringify({ type: "error", message: "Invalid player name" }));
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

    if (r.hands[player].length === 0) {
      // Per rules: can only go out via layoff if also melded this turn
      if (r.hasMeldedThisTurn) return this.playerGoesOut(player);
      // Otherwise hand is empty but they can't go out — edge case, go out anyway
      return this.playerGoesOut(player);
    }
    this.broadcast();
  }

  private handleDoneAction(conn: Party.Connection, player: string | null) {
    if (!player || !this.state.round) return;
    const r = this.state.round;

    if (r.currentTurn !== player || r.turnPhase !== "action") {
      return conn.send(JSON.stringify({ type: "error", message: "Not in action phase" }));
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

  // --- Game logic ---

  private checkAutoStart() {
    const connected = Object.keys(this.state.connections).length;
    if (connected === 2 && this.state.phase === "waiting" && !this.autoStartScheduled) {
      this.autoStartScheduled = true;
      setTimeout(() => {
        this.autoStartScheduled = false;
        if (this.state.phase === "waiting") this.startRound();
      }, 3000);
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

    if (this.state.scores[player] >= WIN_SCORE) {
      this.state.winner = player;
      this.state.phase = "finished";
      this.broadcast();
    } else {
      this.state.phase = "round_over";
      this.broadcast();
      setTimeout(() => {
        if (this.state.phase === "round_over") {
          this.state.phase = "waiting";
          this.broadcast();
          this.checkAutoStart();
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
        this.state.phase = "waiting";
        this.broadcast();
        this.checkAutoStart();
      }
    }, ROUND_OVER_DELAY_MS);
  }

  // --- Validation ---

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
    const { phase, scores, winner, roundNumber, round, lastRoundSummary } = this.state;
    const connectedPlayers = Object.keys(this.state.connections);

    const base: Record<string, unknown> = {
      phase,
      scores,
      winner,
      roundNumber,
      connectedPlayers,
      myName: player,
      lastRoundSummary,
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
