const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const {MongoClient} = require("mongodb");

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

require("dotenv").config();

let lobbies = [];
let leavingPlayerNames = [];

const connectionString = "mongodb+srv://" + process.env.DATABASE_USERNAME + ":" + process.env.DATABASE_PASSWORD + "@cluster0.rwh4ibp.mongodb.net/?retryWrites=true&w=majority";
const client = new MongoClient(connectionString);
let database;

async function connectDatabase() {
    try {
        await client.connect();
        database = client.db("Wherewolf");
        console.log("MongoDB connected");
    }
    catch (error) {
        console.error("MongoDB Connection Error", error);
    }
}

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
            roleChain: [],
            selectedCards: [],
            hasSkippedToVote: false
        }
    }

    socket.on("create-lobby", (playerName) => {

        const lobby = {
            id: crypto.randomUUID(),
            name : playerName + "'s Lobby",
            cards: [],
            state: "waiting",
            selectedRoles: [],
            pendingSwaps: [],
            discussTime: 180,
            remainingDiscussTime: 180,
            messages: []
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

            setTimeout(async () => {
                if (leavingPlayerNames.includes(player.name)) {
                    await handlePlayerLeave(socket.id);
                }
            }, 3000);
        }
    });

    socket.on("leave", async () => {
        await handlePlayerLeave(socket.id);
    });

    async function handlePlayerLeave(targetId) {
        const lobby = lobbies.find(l => l.cards.find(player => player.id === targetId));
        if (lobby) {
            io.to(lobby.id).emit("broadcast-message", lobby.cards.find(player => player.id === targetId).name + " has left");
            if (lobby.state === "waiting" || lobby.state === "select-roles" || lobby.state === "voting-results") {
                lobby.cards = lobby.cards.filter(card => card.id !== targetId);
                if (lobby.state === "select-roles" && lobby.cards.length < 6) {
                    lobby.state = "waiting";
                }
                if (lobby.cards.filter(card => !card.isMiddleCard).every(player => player.id.includes("-disconnected"))) {
                    lobby.cards = lobby.cards.filter(player => !player.id.includes("-disconnected"));
                }
                if (lobby.cards.length === 3) lobbies = lobbies.filter(l => l.id !== lobby.id);
            } else {
                const player = lobby.cards.find(player => player.id === targetId);
                player.vote = "No-one";
                player.hasSeenRole = true;
                player.hasDoneNightAction = true;
                player.hasSkippedToVote = true;
                checkEveryoneHasSeenRole();
                checkEveryoneHasSkippedToVote();
                await checkEveryoneHasVoted(player.vote);
                player.id = crypto.randomUUID() + "-disconnected";
                if (lobby.cards.filter(card => !card.isMiddleCard).every(p => p.id.includes("-disconnected"))) {
                    lobbies = lobbies.filter(l => l.id !== lobby.id);
                }
            }
            io.emit("update-lobbies", lobbies);
            const socketTarget = io.sockets.sockets.get(targetId);
            if (socketTarget) {
                socketTarget.leave(lobby.id);
            }
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
            lobby.startTime = new Date();
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
                if (currentRoles[i].name === "Tanner") {
                    lobby.cards[i].team = "Tanner";
                }
            }

            const players = lobby.cards.filter(card => !card.isMiddleCard);
            for (const player of players) {
                const role = lobby.cards.find(card => card.id === player.id).role;
                if (role === "Villager" || role === "Hunter" || role === "Tanner") {
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
                card.hasSkippedToVote = false;
                delete card.dies;
                delete card.voteAmount;
                delete card.mayLookAtTheirCard;
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
            let swapsHappened = false;
            let nightEnds = false;
            const nightCycle = setInterval(() => {
                nightCounter++;
                lobby.displayText = "It is night time - " +
                    ((nightCounter / 60 < 10 ? "0" : "") + Math.floor(nightCounter / 60)) + ":" +
                    (nightCounter % 60 < 10 ? "0" : "") + nightCounter % 60;
                io.to(lobby.id).emit("update-lobbies", lobbies);

                const players = lobby.cards.filter(card => !card.isMiddleCard);
                if (players.find(p => !p.hasDoneNightAction && p.role !== "Insomniac")) {
                    return;
                }

                // manage swaps
                if (!swapsHappened) {
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
                    swapsHappened = true;
                }
                for (const player of players) {
                    if (player.roleChain[0] === "Insomniac") {
                        player.mayLookAtTheirCard = true;
                    }
                }
                if (!players.every(player => player.hasDoneNightAction)) {
                    return;
                }
                if (!players.find(p => p.roleChain[0] === "Insomniac")) {
                    const threeToTenSecondDelay = Math.floor(Math.random() * (10000 - 2000 + 1)) + 2000;
                    setTimeout(() => {
                        nightEnds = true;
                    }, threeToTenSecondDelay);
                } else {
                    nightEnds = true;
                }
                if (nightEnds) {
                    clearInterval(nightCycle);
                    lobby.state = "day";
                    io.to(lobby.id).emit("reset-night-action-texts");
                    lobby.remainingDiscussTime = lobby.discussTime;

                    // day cycle
                    const dayCycle = setInterval(() => {
                        lobby.remainingDiscussTime--;
                        lobby.displayText = "It is now day time - " +
                            ((lobby.remainingDiscussTime / 60 < 10 ? "0" : "") + Math.floor(lobby.remainingDiscussTime / 60)) + ":" +
                            (lobby.remainingDiscussTime % 60 < 10 ? "0" : "") + lobby.remainingDiscussTime % 60;

                        if (lobby.remainingDiscussTime <= 0) {
                            clearInterval(dayCycle);
                            lobby.state = "voting";
                            io.emit("update-lobbies", lobbies);
                        }
                        io.to(lobby.id).emit("update-lobbies", lobbies);
                    }, 1000);
                }
            }, 1000);
        }
    }

    socket.on("has-done-night-action", () => {
        const lobby = lobbies.find(l => l.cards.find(player => player.id === socket.id));
        if (lobby && lobby.state === "night") {
            lobby.cards.find(player => player.id === socket.id).hasDoneNightAction = true;
            io.emit("update-lobbies", lobbies);
        }
    });

    socket.on("set-has-voted", async (votedPlayerName) => {
        await checkEveryoneHasVoted(votedPlayerName);
    });

    async function checkEveryoneHasVoted(votedPlayerName) {
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

            let mostVotes = 0;
            for (const player of players) {
                if (mostVotes < player.voteAmount) {
                    mostVotes = player.voteAmount;
                }
            }
            if (mostVotes > 1) {
                for (const player of players) {
                    if (player.voteAmount === mostVotes) {
                        player.dies = true;

                        if (player.role === "Hunter") {
                            players.find(p => p.name === player.vote).dies = true;
                        }
                    }
                }
            }

            if (players.find(player => player.team === "Werewolf")) {
                lobby.voteResultText = "No werewolves has been killed";
                lobby.winningTeam = "Werewolf";

                if (players.find(p => p.role === "Werewolf" && p.dies)) {
                    lobby.voteResultText = "At least 1 werewolf has been killed.";
                    lobby.winningTeam = "Villager";
                }
            }

            if (!players.find(player => player.team === "Werewolf")) {
                if (!players.find(player => player.dies)) {
                    lobby.voteResultText = "No player has been killed and their are no werewolves.";
                    lobby.winningTeam = "Villager";
                }
                if (players.find(player => player.dies)) {
                    lobby.voteResultText = "A player has been killed and there are no werewolves.";
                    lobby.winningTeam = "No-one";
                }
            }

            if (players.find(p => p.role === "Tanner" && p.dies)) {
                if (lobby.winningTeam.includes("Villager")) {
                    lobby.winningTeam += " and Tanner";
                    lobby.voteResultText += " and the Tanner died.";
                } else {
                    lobby.winningTeam = "Tanner";
                    lobby.voteResultText = "The Tanner died.";
                }
            }

            // database game storing
            if (!(players.find(p => p.name === "Bread1") && players.find(p => p.name === "Bread2") && players.find(p => p.name === "Bread3"))) {
                const connection = database.collection("games");
                const games = await connection.find().toArray();
                connection.insertOne({
                    id: games.length + 1,
                    lobbyName: lobby.name,
                    selectedRoles: lobby.selectedRoles.map(role => role.name),
                    cards: lobby.cards.map(card => {
                        return {
                            name: card.name,
                            roles: card.roleChain,
                            team: card.team,
                            vote: card.vote,
                            voteAmount: card.voteAmount,
                            isAlive: !card.dies,
                            selectedCards: card.selectedCards
                        }
                    }),
                    winningTeams: lobby.winningTeam,
                    discussionTime: lobby.discussionTime,
                    startTime: lobby.startTime,
                    endTime: new Date()
                });
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
                    clearInterval(lobbyCloseInterval);
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
                    if (player.role === "Drunk" && !lobby.pendingSwaps.find(swap => swap.priority === 8) ||
                        player.role === "Insomniac" || player.roleChain[0] === "Insomniac") {
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

    socket.on("kick-player", async (targetId) => {
        const lobby = lobbies.find(lobby => lobby.cards.find(c => c.id === targetId));

        if (lobby) {
            await handlePlayerLeave(targetId);
            const socketTarget = io.sockets.sockets.get(targetId);
            if (socketTarget) {
                socketTarget.emit("broadcast-message", "You were kicked from the lobby.");
            }
            lobby.cards = lobby.cards.filter(c => c.id !== targetId);
            io.emit("update-lobbies", lobbies);
        }
    });

    socket.on("change-discuss-time", (discussTime) => {
        const lobby = lobbies.find(lobby => lobby.cards.find(c => c.id === socket.id));
        if (lobby) {
            lobby.discussTime = discussTime;
            io.emit("update-lobbies", lobbies);
        }
    });

    socket.on("set-selected-cards", (selectedCards) => {
        const lobby = lobbies.find(lobby => lobby.cards.find(c => c.id === socket.id));
        if (lobby) {
            const player = lobby.cards.find(player => player.id === socket.id);
            if (player) {
                player.selectedCards = selectedCards;
            }
        }
    });

    socket.on("skip-to-vote", () => {
        checkEveryoneHasSkippedToVote();
    });

    function checkEveryoneHasSkippedToVote() {
        const lobby = lobbies.find(lobby => lobby.cards.find(c => c.id === socket.id));
        if (lobby) {
            const players = lobby.cards.filter(card => !card.isMiddleCard);
            const player = players.find(player => player.id === socket.id);
            if (player) {
                player.hasSkippedToVote = true;

                if (players.every(p => p.hasSkippedToVote)) {
                    lobby.remainingDiscussTime = 6;
                }
            }
        }
    }

    socket.on("send-chat-message", (message) => {
        const lobby = lobbies.find(lobby => lobby.cards.find(player => player.id === socket.id));
        if (lobby) {
            const player = lobby.cards.find(player => player.id === socket.id);
            if (player) {
                const messageObject = {
                    sender: player.name,
                    message: message
                }
                lobby.messages.push(messageObject);
                io.to(lobby.id).emit("receive-chat-message", messageObject);
            }
        }
    });

    socket.on("send-console-message", (message) => {
        const lobby = lobbies.find(lobby => lobby.cards.find(player => player.id === socket.id));
        if (lobby) {
            const messageObject = {
                sender: "System",
                message: message
            }
            lobby.messages.push(messageObject);
            io.to(lobby.id).emit("receive-chat-message", messageObject);
        }
    });
});

server.listen(3003,"0.0.0.0", async () => {
    console.log("Access game on https://bread-005.github.io/wherewolf-app/index.html");
    await connectDatabase();
});