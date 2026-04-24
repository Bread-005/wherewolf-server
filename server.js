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
let leavingPlayerNames = [];

io.on("connection", async (socket) => {

    io.emit("update-lobbies", lobbies);
    socket.emit("init", socket.id);

    function createCard(id, name, isMiddleCard) {
        return {
            id: id,
            name: name,
            role: "",
            team: "Villager",
            vote: "",
            hasSeenRole: false,
            hasDoneNightAction: false,
            isMiddleCard: isMiddleCard,
            roleChain: []
        }
    }

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
            lobby.cards.push(createCard(crypto.randomUUID(), "middle-card" + (i + 1), true));
        }
        lobby.cards.push(createCard(socket.id, playerName, false));
        socket.join(lobby.id);
        lobbies.push(lobby);

        io.emit("update-lobbies", lobbies);
    });

    socket.on("join-game", ({name, lobbyId}) => {
        const lobby = lobbies.find(l => l.id === lobbyId);
        if (!lobby) return;

        lobby.cards.push(createCard(socket.id, name, false));
        socket.join(lobby.id);
        io.emit("update-lobbies", lobbies);
    });

    socket.on("request-lobby-data", (lobbyId) => {
        const lobby = lobbies.find(l => l.id === lobbyId);
        if (lobby) {
            socket.emit("update-lobbies", lobbies);
        }
    });

    socket.on("disconnect", () => {
        const lobby = lobbies.find(lobby => lobby.cards.find(player => player.id === socket.id));
        if (lobby) {
            const player = lobby.cards.find(player => player.id === socket.id);
            leavingPlayerNames.push(player.name);

            setTimeout(() => {
                if (leavingPlayerNames.includes(player.name)) {
                    handlePlayerLeave();
                }
            }, 3000);
        }
    });

    socket.on("leave", () => {
        handlePlayerLeave();
    });

    function handlePlayerLeave() {
        const lobby = lobbies.find(l => l.cards.find(player => player.id === socket.id));
        if (lobby) {
            io.to(lobby.id).emit("broadcast-message", lobby.cards.find(player => player.id === socket.id).name + " has left");
            if (lobby.state === "waiting" || lobby.state === "select-roles" || lobby.state === "voting-results") {
                lobby.cards = lobby.cards.filter(card => card.id !== socket.id);
                if (lobby.state === "select-roles" && lobby.cards.length < 6) {
                    lobby.state = "waiting";
                }
                if (lobby.cards.length === 3) lobbies = lobbies.filter(l => l.id !== lobby.id);
            } else {
                const player = lobby.cards.find(player => player.id === socket.id);
                player.vote = "No-one";
                player.hasSeenRole = true;
                player.hasDoneNightAction = true;
                checkEveryoneHasSeenRole();
                setHasDoneNightAction();
                checkEveryoneHasVoted(player.vote);
                player.id = crypto.randomUUID() + "-disconnected";
                if (lobby.cards.filter(card => !card.isMiddleCard).every(p => p.id.includes("-disconnected"))) {
                    lobbies = lobbies.filter(l => l.id !== lobby.id);
                }
            }
            io.emit("update-lobbies", lobbies);
            socket.leave(lobby.id);
        }
    }

    socket.on("request-role-selection", (lobbyId) => {
        io.to(lobbyId).emit("show-select-roles-screen", lobbyId);
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
                lobby.cards[i].roleChain.push(currentRoles[i].name);
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
            lobby.cards = lobby.cards.filter(player => !player.id.includes("-disconnected"));
            for (const card of lobby.cards) {
                card.role = "";
                card.team = "Villager";
                card.hasSeenRole = false;
                card.hasDoneNightAction = false;
                card.vote = "";
                card.roleChain = [];
                delete card.dies;
                delete card.voteAmount;
            }
            lobby.state = "waiting";
            lobby.pendingSwaps = [];
            io.emit("update-lobbies", lobbies);
        }
    });

    socket.on("check-has-seen-role", () => {
        checkEveryoneHasSeenRole();
    });

    function checkEveryoneHasSeenRole() {
        const lobby = lobbies.find(l => l.cards.find(player => player.id === socket.id));
        if (lobby && lobby.state === "look-at-role") {
            lobby.cards.find(player => player.id === socket.id).hasSeenRole = true;
            const players = lobby.cards.filter(card => !card.isMiddleCard);
            if (!players.every(player => player.hasSeenRole)) {
                return;
            }
            lobby.state = "night";
            io.emit("update-lobbies", lobbies);
            io.to(lobby.id).emit("setup-night");

            // night cycle
            let nightCounter = 0;
            const nightCycle = setInterval(() => {
                nightCounter++;
                lobby.displayText = "It is night time - " +
                    ((nightCounter / 60 < 10 ? "0" : "") + Math.floor(nightCounter / 60)) + ":" +
                    (nightCounter % 60 < 10 ? "0" : "") + nightCounter % 60;
                io.emit("update-lobbies", lobbies);

                const players = lobby.cards.filter(card => !card.isMiddleCard);
                if (!players.every(player => player.hasDoneNightAction)) {
                    return;
                }

                // manage swaps
                lobby.pendingSwaps.sort((a, b) => a.priority - b.priority);
                for (const swap of lobby.pendingSwaps) {
                    const card1 = lobby.cards.find(card => card.name === swap.swap[0].name);
                    const card2 = lobby.cards.find(card => card.name === swap.swap[1].name);
                    if (card1 && card2) {
                        const card1Role = card1.role;
                        const card1Team = card1.team;
                        card1.role = card2.role;
                        card1.roleChain.push(card1.role);
                        card1.team = card2.team;
                        card2.role = card1Role;
                        card2.roleChain.push(card2.role);
                        card2.team = card1Team;
                    }
                }
                clearInterval(nightCycle);
                lobby.state = "day";
                io.to(lobby.id).emit("reset-night-action-texts");

                // day cycle
                let discussionTime = 6;
                const dayCycle = setInterval(() => {
                    discussionTime--;
                    lobby.displayText = "It is now day time - " +
                        ((discussionTime / 60 < 10 ? "0" : "") + Math.floor(discussionTime / 60)) + ":" +
                        (discussionTime % 60 < 10 ? "0" : "") + discussionTime % 60;

                    if (discussionTime <= 0) {
                        clearInterval(dayCycle);
                        lobby.state = "voting";
                        io.emit("update-lobbies", lobbies);
                    }
                    io.emit("update-lobbies", lobbies);
                }, 1000);
            }, 1000);
        }
    }

    socket.on("has-done-night-action", () => {
        setHasDoneNightAction();
    });

    function setHasDoneNightAction() {
        const lobby = lobbies.find(l => l.cards.find(player => player.id === socket.id));
        if (lobby && lobby.state === "night") {
            lobby.cards.find(player => player.id === socket.id).hasDoneNightAction = true;
            io.emit("update-lobbies", lobbies);
        }
    }

    socket.on("set-has-voted", (votedPlayerName) => {
        checkEveryoneHasVoted(votedPlayerName);
    });

    function checkEveryoneHasVoted(votedPlayerName) {
        const lobby = lobbies.find(l => l.cards.find(player => player.id === socket.id));
        if (lobby && lobby.state === "voting") {

            const players = lobby.cards.filter(card => !card.isMiddleCard);
            lobby.cards.find(player => player.id === socket.id).vote = votedPlayerName;
            io.emit("update-lobbies", lobbies);
            if (!players.every(player => player.vote)) return;

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
            io.to(lobby.id).emit("everyone-voted");

            let lobbyCloseCount = 0;
            const lobbyCloseInterval = setInterval(() => {
                lobbyCloseCount++;
                if (lobby.state !== "voting-results") {
                    clearInterval(lobbyCloseInterval);
                }

                if (lobbyCloseCount > 180) {
                    io.to(lobby.id).emit("broadcast-message", "The lobby closed due to inactivity");
                    io.socketsLeave(lobby.id);
                    lobbies = lobbies.filter(l => l.id !== lobby.id);
                    io.emit("update-lobbies", lobbies);
                }
            }, 1000);
        }
    }

    socket.on("add-swap", ({priority, swap}) => {
        const lobby = lobbies.find(lobby => lobby.cards.find(player => player.id === socket.id));
        if (lobby) {
            lobby.pendingSwaps.push({
                priority: priority,
                swap: swap
            });
        }
    });

    socket.on("reconnect-player", (savedId) => {
        const lobby = lobbies.find(lobby => lobby.cards.find(player => player.id === savedId));
        if (lobby) {
            const player = lobby.cards.find(player => player.id === savedId);
            if (player) {
                player.id = socket.id;
                leavingPlayerNames = leavingPlayerNames.filter(name => name !== player.name);
                if (lobby.state === "night" && !player.hasDoneNightAction) {
                    player.hasDoneNightAction = true;
                    if (player.role === "Drunk" && !lobby.pendingSwaps.find(swap => swap.priority === 8)) {
                        player.hasDoneNightAction = false;
                    }
                }
                socket.join(lobby.id);
                io.emit("update-lobbies", lobbies);
                if (lobby.state === "night") {
                    socket.emit("setup-night");
                }
            }
        }
    });
});

server.listen(3003,"0.0.0.0", () => {
    console.log("Access game on https://bread-005.github.io/wherewolf-app/index.html");
});