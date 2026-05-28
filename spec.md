# App Spec

## Overview

This document specifies an Alice in Wonderland themed Rummy card game designed to be played online by two players.

## Target Users

The target users are two friends who know the rules of rummy and wish to play each other online.

## Core Features

List the must-have features. Be specific — include what inputs the user provides, what the system does, and what output/result they see.

1. **Feature name** — description of behavior
2. **Feature name** — description of behavior
3. **Feature name** — description of behavior

## Out of Scope

_What is explicitly NOT included in this version? Listing exclusions prevents scope creep._

- Not building X
- No support for Y

## User Flows

Describe the key paths a user takes through the app, step by step.

### Flow 1: Game Start

1. When the game starts the user is shown the start screen. The background to this screen is assets/splash/background.png. There is a button saying "Start Game".
2. When the Start Game button is pressed then the user is taken to the Select screen.

### Flow 2: Select Options

1. The Select screen shows the option to pick one of two characters: Tas or Steve. The selection is made by clicking on the avatar for one or the other.
   1. The avatar image for Tas is in `assets/select/avatar-tas.png`
   2. The avatar image for Steve is in `assets/select/avatar-steve.png`
   3. The avatar buttons are displayed in the center of the screen side by side with spacing between them and a dark grey border around them.
2. When the player selects an avatar, that avatar gets a glowing blue border.
3. If the other player is already connected and has selected the opposite avatar, that avatar has a glowing green border and the text "Connected" appears underneath it. That avatar is not selectable by the current player.
4. Selecting an avatar sends a join request to the server and keeps the user on the Select screen until both players are connected.
   1. If the second player is not yet connected, display a centered message under the avatars: "Waiting for other player..."
   2. Once the second player connects with the other avatar, both clients move to the Game screen and the round begins immediately.
5. The Select screen background is `assets/select/background.png`.
6. A **Reset** button is displayed on the Select screen. When pressed, the player is immediately returned to the Game Start screen. The WebSocket connection is closed, the server removes the player from the session, and all local state (player name, game state) is cleared. No confirmation dialog is shown.

### Flow 3: Reset

1. When the game ends, the Finish screen shows a "Play Again" button.
2. Pressing "Play Again" sends a reset request to the server.
3. The server clears the current match state, resets scores to zero, and returns the room to the waiting state.
4. If both players remain connected, the server immediately begins a new round and both clients transition to the Game screen.
5. If one player disconnects before the reset is applied, the remaining player stays on the Select screen and waits for the other player to join.

### Flow 4: End Game

1. At any point during the Game screen, either player may press the **End Game** button.
2. A confirmation dialog appears asking "Are you sure you want to end the game?", with a **Yes** button and a **No** button.
3. If the player selects **No**, the dialog closes and the game continues as normal.
4. If the player selects **Yes**:
   - The server resets all game state (scores, round, connections).
   - Both players are navigated to the Game Start (Splash) screen.
   - All local client state (player name, hand, selections) is cleared.


## Tech Stack

The online server should use PartyKit and be implemented in TypeScript.

The client will be a Single Page Application (SPA) written in HTML, CSS and JavaScript

## UI / Interface

The UI will be designed and optimised for portrait mode on a smart phone.

There will be the following screens:
- Splash - which shows the background and logo of the game along with the start button.
- Select - which allows the user to select whether they are a player called "Tas" or "Steve" before opting to start the game.
- Game - which shows the card table where the game is played.
- Finish - which shows the conclusion and result of the game.

## Game Rules

### Deck

A standard 52-card deck is used (no Jokers). Cards rank Ace (low) through King.

### Deal

Each player is dealt 10 cards. The remaining cards form the **stock pile** face-down. The top card of the stock is turned face-up to start the **discard pile**.

### Turn Structure

Players alternate turns. On each turn a player must:

1. **Draw** — take either the top card of the discard pile or the top card of the stock pile.
2. **Meld / Lay off** (optional) — play any number of melds to the table, and/or lay off cards onto existing melds (see below).
3. **Discard** — place one card face-up on the discard pile. (If the player drew from the discard pile they may not discard that same card on the same turn.)

### Melds

There are two types of valid meld:

- **Set** — three or four cards of the same rank (e.g. 7♠ 7♥ 7♦).
- **Run** — three or more consecutive cards of the same suit (e.g. 4♣ 5♣ 6♣ 7♣). Ace is always low (A-2-3 is valid; Q-K-A is not).

A meld must contain at least three cards when first laid to the table.

### Laying Off

A player may add one or more cards from their hand to any meld already on the table (either their own or their opponent's), provided the resulting meld remains valid.

### Going Out

A player **goes out** when they have played all cards from their hand (last card is either melded or discarded with nothing remaining). A player may not go out by laying off unless they have also melded or discarded their final card in the same turn.

### Scoring

When a player goes out, the round ends immediately. The **losing player's** remaining hand cards are scored against them:

| Card | Points |
|------|--------|
| Ace | 1 |
| 2–10 | Face value |
| Jack, Queen, King | 10 |

The winning player scores those points. The first player to reach **100 points** across multiple rounds wins the game.

### Stock Exhaustion

If the stock pile is exhausted before either player goes out, the discard pile is shuffled (excluding the top card) and placed face-down as the new stock pile. If the stock is exhausted a second time in the same round with no winner, the round is declared a draw and no points are awarded.

### Turn Order

The player who did not deal goes first. The deal alternates between rounds.

## Non-Functional Requirements

The PartyKit URL will be "rummy-game.stephengale.partykit.dev"

The project source shall be in a sub-directory called src.
The CSS and JavaScript files should be external to the HTML file. There will be an assets directory alongside src where game images will be located and referenced from.

## Open Questions

_Decisions not yet made. List them so Claude can flag or make a reasonable default choice._

- [ ] Question 1
- [ ] Question 2