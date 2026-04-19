const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: ['http://localhost:63342', 'https://bread-005.github.io'],
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization']
    }
});

app.use(express.static(__dirname));

let lobbies = [];

io.on("connection", async (socket) => {

    socket.emit("init", socket.id);
    io.emit("update-lobbies", lobbies);

    socket.on("create-lobby", (playerName) => {

        const lobby = {
            id: crypto.randomUUID(),
            name : playerName + "'s Lobby",
            cards: [],
            state: "waiting",
            selectedRoles: [],
            pendingSwaps: []
        }

        for (let i = 0; i < 3; i++) {
            const middleCard = {
                id: crypto.randomUUID(),
                name: "middle-card" + (i + 1),
                role: "",
                team: "Villager",
                vote: "",
                hasSeenRole: false,
                hasDoneNightAction: false,
                isMiddleCard: true
            }
            lobby.cards.push(middleCard);
        }
        lobby.cards.push({
            id: socket.id,
            name: playerName,
            role: "",
            team: "Villager",
            vote: "",
            hasSeenRole: false,
            hasDoneNightAction: false,
            isMiddleCard: false
        });
        lobbies.push(lobby);

        socket.emit("send-to-game", lobbies[lobbies.length - 1].id);
        io.emit("update-lobbies", lobbies);
    });

    socket.on("join-game", ({name, lobbyId}) => {
        const lobby = lobbies.find(l => l.id === lobbyId);
        if (!lobby) return;

        lobby.cards.push({
            id: socket.id,
            name: name,
            role: "",
            team: "Villager",
            vote: "",
            hasSeenRole: false,
            hasDoneNightAction: false,
            isMiddleCard: false
        });
        socket.emit("send-to-game", lobby.id);
        io.emit("update-lobbies", lobbies);
    });

    socket.on("request-lobby-data", (lobbyId) => {
        const lobby = lobbies.find(l => l.id === lobbyId);
        if (lobby) {
            socket.emit("update-lobbies", lobbies);
        }
    });

    socket.on("disconnect", () => {
        handlePlayerLeave();
    });

    socket.on("leave", () => {
        handlePlayerLeave();
    });

    function handlePlayerLeave() {
        const lobby = lobbies.find(l => l.cards.find(player => player.id === socket.id));
        if (lobby) {
            lobby.cards = lobby.cards.filter(card => card.id !== socket.id);
            if (lobby.cards.length === 3) lobbies = lobbies.filter(l => l.id !== lobby.id);
            io.emit("update-lobbies", lobbies);
        }
    }

    socket.on("request-role-selection", (lobbyId) => {
        io.emit("show-select-roles-screen", lobbyId);
    });

    socket.on("request-update-selected-roles", ({lobbyId, role}) => {
        const lobby = lobbies.find(l => l.id === lobbyId);
        if (!lobby) return;

        const index = lobby.selectedRoles.findIndex(r => r.id === role.id);
        if (index > -1) {
            lobby.selectedRoles.splice(index, 1);
        } else {
            lobby.selectedRoles.push(role);
        }
        io.emit("update-lobbies", lobbies);
    });

    socket.on("set-roles-for-all-cards", (lobbyId) => {
        const lobby = lobbies.find(l => l.id === lobbyId);
        if (lobby) {
            const currentRoles = [];
            for (const role of lobby.selectedRoles) {
                currentRoles.push(role);
            }
            currentRoles.sort(() => Math.random() - 0.5);

            for (let i = 0; i < currentRoles.length; i++) {
                lobby.cards[i].role = currentRoles[i].name;
                if (currentRoles[i].name === "Werewolf") {
                    lobby.cards[i].team = "Werewolf";
                }
            }

            const players = lobby.cards.filter(card => !card.isMiddleCard);
            for (const player of players) {
                if (lobby.cards.find(card => card.id === player.id).role === "Villager") {
                    player.hasDoneNightAction = true;
                }
            }
            lobby.state = "look-at-role";
        }
        io.emit("update-lobbies", lobbies);
    });

    socket.on("update-state", ({id, state}) => {
        const lobby = lobbies.find(l => l.id === id);
        if (lobby) {
            lobby.state = state;
        }
        io.emit("update-lobbies", lobbies);
    });

    socket.on("reset-lobby", () => {
        const lobby = lobbies.find(l => l.cards.find(player => player.id === socket.id));
        if (lobby) {
            for (const card of lobby.cards) {
                card.role = "";
                card.team = "Villager";
            }
            for (const player of lobby.cards.filter(card => !card.isMiddleCard)) {
                player.hasSeenRole = false;
                player.hasDoneNightAction = false;
                player.vote = "";
            }
            lobby.state = "waiting";
            lobby.pendingSwaps = [];
            io.emit("update-lobbies", lobbies);
        }
    });

    socket.on("check-has-seen-role", () => {
        const lobby = lobbies.find(l => l.cards.find(player => player.id === socket.id));
        if (lobby) {
            lobby.cards.find(player => player.id === socket.id).hasSeenRole = true;
            const players = lobby.cards.filter(card => !card.isMiddleCard);
            if (players.filter(p => p.hasSeenRole).length < players.length) {
                return;
            }
            let counter = 0;
            lobbies.find(l => l.cards.find(player => player.id === socket.id)).state = "night";
            io.emit("update-lobbies", lobbies);

            const nightPhase = setInterval(() => {
                counter++;
                lobby.displayText = "It is night time - " + ((counter / 60 < 10 ? "0" : "") + Math.floor(counter / 60)) + ":" + (counter % 60 < 10 ? "0" : "") + counter % 60;
                io.emit("update-lobbies", lobbies);

                const players = lobby.cards.filter(card => !card.isMiddleCard);
                if (players.filter(p => p.hasDoneNightAction).length < players.length) {
                    return;
                }

                // manage swaps
                lobby.pendingSwaps.sort((a, b) => a.priority - b.priority);
                for (const swap of lobby.pendingSwaps) {
                    const card1 = lobby.cards.find(card => card.id === swap.swap[0].id);
                    const card2 = lobby.cards.find(card => card.id === swap.swap[1].id);
                    const card1Role = lobby.cards.find(card => card.id === swap.swap[0].id).role;
                    card1.role = lobby.cards.find(card => card.id === swap.swap[1].id).role;
                    card2.role = card1Role;
                }
                console.log(JSON.stringify(lobby.cards.map(card => card.name + ": " + card.role)));
                //

                io.emit("reset-night-action-texts");
                clearInterval(nightPhase);
                let discussionTime = 6;
                lobbies.find(l => l.cards.find(player => player.id === socket.id)).state = "day";
                io.emit("update-lobbies", lobbies);
                const dayPhase = setInterval(() => {
                    discussionTime--;
                    lobby.displayText = "It is now day time - " + ((discussionTime / 60 < 10 ? "0" : "") + Math.floor(discussionTime / 60)) + ":" + (discussionTime % 60 < 10 ? "0" : "") + discussionTime % 60;

                    if (discussionTime <= 0) {
                        lobbies.find(l => l.cards.find(player => player.id === socket.id)).state = "voting";
                        io.emit("update-lobbies", lobbies);
                        io.emit("initialise-voting");
                        clearInterval(dayPhase);
                    }
                    io.emit("update-lobbies", lobbies);
                }, 1000);
            }, 1000);
        }
    });

    socket.on("has-done-night-action", () => {
        const lobby = lobbies.find(l => l.cards.find(player => player.id === socket.id));
        if (lobby) {
            for (const player of lobby.cards) {
                if (player.id === socket.id) {
                    player.hasDoneNightAction = true;
                }
            }
            io.emit("update-lobbies", lobbies);
        }
    });

    socket.on("set-has-voted", (votedPlayerName) => {
        const lobby = lobbies.find(l => l.cards.find(player => player.id === socket.id));
        if (lobby) {
            const players = lobby.cards.filter(card => !card.isMiddleCard);
            players.find(player => player.id === socket.id).vote = votedPlayerName;
            io.emit("update-lobbies", lobbies);
            if (players.filter(player => player.vote).length === players.length) {
                lobby.state = "voting-results";


                // evaluate who has won
                for (const player of players) {
                    player.voteAmount = 0;
                    for (const player1 of players) {
                        if (player.id === player1.id) continue;

                        if (player1.vote === player.name) {
                            player.voteAmount++;
                        }
                    }
                }
                lobby.voteResultText = "No werewolves has been killed";
                lobby.winningTeam = "Werewolf";

                let mostVotes = 0;
                for (const player of players) {
                    if (mostVotes < player.voteAmount) {
                        mostVotes = player.voteAmount;
                    }
                }
                if (mostVotes > 1) {
                    for (const player of players) {
                        if (player.voteAmount >= mostVotes) {
                            player.dies = true;
                        }
                    }
                    for (const player of players) {
                        if (player.dies && player.role === "Werewolf") {
                            lobby.voteResultText = "At least 1 werewolf has been killed";
                            lobby.winningTeam = "Villager";
                        }
                    }
                }

                if (!players.find(player => player.role === "Werewolf")) {
                    if (!players.find(player => player.dies)) {
                        lobby.voteResultText = "No player has been killed and their are no werewolves.";
                        lobby.winningTeam = "Villager";
                    }
                    if (players.find(player => player.dies)) {
                        lobby.voteResultText = "A player has been killed and their are no werewolves.";
                        lobby.winningTeam = "No-one";
                    }
                }

                io.emit("update-lobbies", lobbies);
                io.emit("everyone-voted");
            }
        }
    });

    socket.on("add-swap", ({priority, swap}) => {
        const lobby = lobbies.find(lobby => lobby.cards.find(player => player.id === socket.id));
        if (lobby) {
            lobby.pendingSwaps.push({
                priority: priority,
                swap: swap
            });
        }
    });
});

server.listen(3003,"0.0.0.0", () => {
    console.log("Access game on https://bread-005.github.io/wherewolf-app/index.html");
});