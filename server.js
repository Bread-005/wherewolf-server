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
let allRoles = [];

const connectionString = "mongodb+srv://" + process.env.DATABASE_USERNAME + ":" + process.env.DATABASE_PASSWORD + "@cluster0.rwh4ibp.mongodb.net/?retryWrites=true&w=majority";
const client = new MongoClient(connectionString);
let database;

async function connectDatabase() {
    try {
        await client.connect();
        database = client.db("Wherewolf");
        allRoles = await fetch("https://raw.githubusercontent.com/Bread-005/wherewolf-app/main/roles.json").then(res => res.json());
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
            dies: false,
            voteAmount: 0,
            roleChain: [],
            selectedCards: [],
            hasSkippedToVote: false,
            startingRole: "",
            isRevealed: false,
            hasClickedConfirm: false,
            DGhasViewedCard: false,
            mayDoLateAction: false,
            sawWaitMessage: false,
            viewableStartingRole: ""
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
            messages: [],
            nightTimer: 0
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
        if (isTesting(lobby)) {
            lobby.discussTime = 5;
        }
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
            }, 5000);
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
                if (lobby.state === "voting-results") {
                    const player = lobby.cards.find(player => player.id === targetId);
                    player.id = crypto.randomUUID() + "-disconnected";
                }
                if (lobby.state !== "voting-results") {
                    lobby.cards = lobby.cards.filter(card => card.id !== targetId);
                }
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
            if (!isTesting(lobby)) {
                currentRoles.sort(() => Math.random() - 0.5);
            }

            for (let i = 0; i < currentRoles.length; i++) {
                lobby.cards[i].role = currentRoles[i].name;
                lobby.cards[i].roleChain.push(currentRoles[i].name);
                lobby.cards[i].startingRole = currentRoles[i].name;
                lobby.cards[i].viewableStartingRole = currentRoles[i].name;
                if (currentRoles[i].name === "Werewolf" || currentRoles[i].name === "Minion") {
                    lobby.cards[i].team = "Werewolf";
                }
                if (currentRoles[i].name === "Tanner") {
                    lobby.cards[i].team = "Tanner";
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
                card.dies = false;
                card.voteAmount = 0;
                card.roleChain = [];
                card.selectedCards = [];
                card.hasSkippedToVote = false;
                card.startingRole = "";
                card.isRevealed = false;
                card.hasClickedConfirm = false;
                card.DGhasViewedCard = false;
                card.mayDoLateAction = false;
                card.sawWaitMessage = false;
                card.viewableStartingRole = "";
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

            // night cycle
            lobby.nightTimer = 0;
            io.emit("update-lobbies", lobbies);
            let swapsHappened = false;
            let nightEnds = false;
            const nightCycle = setInterval(() => {
                lobby.nightTimer++;
                lobby.displayText = "It is night time - " +
                    ((lobby.nightTimer / 60 < 10 ? "0" : "") + Math.floor(lobby.nightTimer / 60)) + ":" +
                    (lobby.nightTimer % 60 < 10 ? "0" : "") + lobby.nightTimer % 60;
                io.to(lobby.id).emit("update-lobbies", lobbies);

                const players = lobby.cards.filter(card => !card.isMiddleCard);

                // manage swaps
                if (!swapsHappened) {
                    if (players.every(p => p.startingRole !== "Robber" && p.startingRole !== "Troublemaker" && p.startingRole !== "Drunk"
                        && (p.roleChain[0] !== "Doppelganger" || p.hasClickedConfirm || allRoles.find(role => role.name === p.startingRole).nightOrder > 8.9) || p.hasClickedConfirm)) {
                        lobby.pendingSwaps.sort((a, b) => a.priority - b.priority);
                        for (const swap of lobby.pendingSwaps) {
                            swapCards(lobby, swap);
                        }
                        swapsHappened = true;
                        players.forEach(p => p.mayDoLateAction = true);
                        io.to(lobby.id).emit("update-lobbies", lobbies);
                    }
                }
                if (!players.every(player => player.hasDoneNightAction)) {
                    return;
                }
                const oneToTenSecondDelay = Math.floor(Math.random() * (10000 - 1000 + 1)) + 1000;
                setTimeout(() => {
                    nightEnds = true;
                }, oneToTenSecondDelay);

                if (nightEnds) {
                    clearInterval(nightCycle);
                    lobby.state = "day";
                    io.to(lobby.id).emit("start-day");
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
            const player = lobby.cards.find(player => player.id === socket.id);
            player.hasClickedConfirm = true;
            if (player.roleChain[0] === "Doppelganger" && !player.DGhasViewedCard) {
                player.hasClickedConfirm = false;
                player.DGhasViewedCard = true;
                player.sawWaitMessage = false;
            } else {
                player.hasDoneNightAction = true;
                io.to(lobby.id).emit("update-lobbies", lobbies);
            }
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
                    }
                }

                // check Hunter deaths twice because Doppelganger-Hunter
                for (let i = 0; i < 2; i++) {
                    for (const player of players) {
                        if (player.role === "Hunter" || player.role === "Doppelganger" && player.startingRole === "Hunter") {
                            players.find(p => p.name === player.vote).dies = true;
                        }
                    }
                }
            }

            if (players.find(player => player.role === "Werewolf")) {
                lobby.voteResultText = "No werewolves died.";
                lobby.winningTeam = "Werewolf";

                if (players.find(p => p.role === "Werewolf" && p.dies)) {
                    lobby.voteResultText = "a werewolf died.";
                    lobby.winningTeam = "Villager";
                }
            }

            if (!players.find(player => player.role === "Werewolf")) {
                if (!players.find(player => player.dies)) {
                    lobby.voteResultText = "Everyone lives";
                    lobby.winningTeam = "Villager";
                }
                if (players.find(player => player.dies)) {
                    lobby.voteResultText = "Someone died";
                    lobby.winningTeam = "No-one";
                }
                if (players.find(p => p.role === "Minion" && !p.dies)) {
                    lobby.voteResultText = "The Minion survived";
                    lobby.winningTeam = "Werewolf";
                }
                if (players.find(p => p.role === "Minion" && p.dies)) {
                    lobby.voteResultText = "The Minion died";
                    lobby.winningTeam = "Villager";
                }
                lobby.voteResultText += " and there are no werewolves.";
            }

            for (const player of players) {
                if (player.dies) {
                    if (player.role === "Tanner" || player.team === "Doppelganger-Tanner") {
                        if (lobby.winningTeam.length > 0 && lobby.winningTeam !== "No-one") {
                            lobby.winningTeam += " and " + player.team;
                            lobby.voteResultText += " and the " + player.team + " died.";
                        } else {
                            lobby.winningTeam = player.team;
                            lobby.voteResultText = "The " + player.team + " died.";
                        }
                    }
                }
            }

            // database game storing
            if (!isTesting(lobby)) {
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
                            selectedCards: card.selectedCards.map(card => card.name)
                        }
                    }),
                    winningTeams: lobby.winningTeam,
                    discussTime: lobby.discussTime,
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
                    player.hasClickedConfirm = true;
                    if (player.startingRole === "Doppelganger" || player.startingRole === "Drunk" && !lobby.pendingSwaps.find(swap => swap.priority === 8) ||
                        !player.mayDoLateAction && allRoles.find(role => role.name === player.startingRole).nightOrder > 8.9) {
                        player.hasDoneNightAction = false;
                        player.hasClickedConfirm = false;
                    }
                }
                socket.join(lobby.id);
                io.emit("update-lobbies", lobbies);
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
            io.to(lobby.id).emit("update-lobbies", lobbies);
        }
    });

    socket.on("add-selected-cards", (selectedCards) => {
        const lobby = lobbies.find(lobby => lobby.cards.find(c => c.id === socket.id));
        if (lobby) {
            const player = lobby.cards.find(player => player.id === socket.id);
            if (player) {
                for (const card of selectedCards) {
                    player.selectedCards.push(card);
                }
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

    socket.on("perform-swap", ({swap}) => {
        const lobby = lobbies.find(lobby => lobby.cards.find(player => player.id === socket.id));
        if (lobby) {
            const firstCardRole = lobby.cards.find(card => card.name === swap[0].name).role;
            const secondCardRole = lobby.cards.find(card => card.name === swap[1].name).role;
            lobby.cards.find(card => card.name === swap[1].name).viewableStartingRole = firstCardRole;
            lobby.cards.find(card => card.name === swap[0].name).viewableStartingRole = secondCardRole;
            swapCards(lobby, {swap: swap});
        }
    });

    function swapCards(lobby, swap) {
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

    socket.on("turn-over-card", () => {
        const lobby = lobbies.find(lobby => lobby.cards.find(player => player.id === socket.id));
        if (lobby) {
            const player = lobby.cards.find(player => player.id === socket.id);
            if (player) {
                const selectedCard = lobby.cards.find(card => card.name === player.selectedCards.at(-1).name);
                selectedCard.isRevealed = true;
                io.to(lobby.id).emit("update-lobbies", lobbies);
            }
        }
    });

    socket.on("has-clicked-confirm", () => {
        const lobby = lobbies.find(l => l.cards.find(player => player.id === socket.id));
        if (lobby && lobby.state === "night") {
            const player = lobby.cards.find(player => player.id === socket.id);
            if (player.hasClickedConfirm) {
                return;
            }
            player.hasClickedConfirm = true;
            if (player.startingRole === "Doppelganger") {
                player.startingRole = player.selectedCards[0].role;
                player.team = player.selectedCards[0].team;
                if (player.team === "Tanner") {
                    player.team = "Doppelganger-Tanner";
                }
            }
            io.to(lobby.id).emit("update-lobbies", lobbies);
        }
    });

    function isTesting(lobby) {
        return lobby.cards.find(p => p.name === "Bread1") && lobby.cards.find(p => p.name === "Bread2") && lobby.cards.find(p => p.name === "Bread3");
    }

    socket.on("saw-wait-message", () => {
        const lobby = lobbies.find(lobby => lobby.cards.find(player => player.id === socket.id));
        if (lobby) {
            const player = lobby.cards.find(player => player.id === socket.id);
            if (player) {
                player.sawWaitMessage = true;
                io.to(lobby.id).emit("update-lobbies", lobbies);
            }
        }
    });
});

server.listen(3003,"0.0.0.0", async () => {
    console.log("Access game on https://bread-005.github.io/wherewolf-app/index.html");
    await connectDatabase();
});