import express from "express";
import {Server} from "socket.io";
import http from "http";
import {fileURLToPath} from "url";
import {dirname} from "path";
import {connectDatabase, saveGameToDatabase} from "./database.js";
import {evaluateVotingResults} from "./votingResults.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: ['http://localhost:63342', 'https://bread-005.github.io'],
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization']
    }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.use(express.static(__dirname));

let lobbies = [];
let leavingPlayerNames = [];
let allRoles = [];

function findLobbyByCardId(cardId) {
    return lobbies.find(lobby => lobby.cards.find(card => card.id === cardId));
}

io.on("connection", async (socket) => {

    io.emit("update-lobbies", lobbies);
    socket.emit("init", socket.id);

    function resetCardState(card) {
        card.role = "";
        card.team = "Villager";
        card.vote = "";
        card.hasSeenRole = false;
        card.hasDoneNightAction = false;
        card.dies = false;
        card.voteAmount = 0;
        card.roleChain = [];
        card.selectedCards = [];
        card.hasSkippedToVote = false;
        card.startingRole = "";
        card.isRevealed = false;
        card.hasClickedConfirm = false;
        card.hasCopiedRole = false;
        card.mayDoLateAction = false;
        card.sawWaitMessage = false;
        card.viewableStartingRole = "";
        card.viewableStartingTeam = "";
        card.isSentinelled = false;
        card.hasMetWerewolves = false;
        card.hasDoneExtraWolfAction = false;
        card.didFirstPart = false;
        card.mainAbility = "";
        card.witchHasViewedCard = false;
        card.viewableCopycatRole = "";
        card.viewableCopycatTeam = "";
        card.bumpedList = [];
    }

    function createCard(id, name) {
        const card = {
            id: id,
            name: name,
            isMiddleCard: name.includes("middle-card")
        };
        resetCardState(card);
        return card;
    }

    function findLobbyBySocketId() {
        return findLobbyByCardId(socket.id);
    }

    function getPlayers(lobby) {
        return lobby.cards.filter(card => !card.isMiddleCard);
    }

    function formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return (minutes < 10 ? "0" : "") + minutes + ":" + (remainingSeconds < 10 ? "0" : "") + remainingSeconds;
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
            nightTimer: 0,
            winningTeam: "",
            voteResultText: "",
            randomActions: [],
            tempMessages: [],
            selectedEditions: ["base game"],
            oracleAnswer: ""
        }

        for (let i = 0; i < 3; i++) {
            lobby.cards.push(createCard(crypto.randomUUID(), "middle-card" + (i + 1)));
        }
        lobby.cards.push(createCard(socket.id, playerName));
        socket.join(lobby.id);
        lobbies.push(lobby);

        io.emit("update-lobbies", lobbies);
    });

    socket.on("join-game", ({name, lobbyId}) => {
        const lobby = lobbies.find(l => l.id === lobbyId);
        if (lobby) {
            lobby.cards.push(createCard(socket.id, name));
            socket.join(lobby.id);
            if (isTesting(lobby)) {
                lobby.discussTime = 5;
            }
            io.emit("update-lobbies", lobbies);
        }
    });

    socket.on("disconnect", () => {
        const lobby = findLobbyBySocketId();
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

                if (getPlayers(lobby).every(player => player.id.includes("-disconnected"))) {
                    lobby.cards = lobby.cards.filter(player => !player.id.includes("-disconnected"));
                }
                if (getPlayers(lobby).length === 0) lobbies = lobbies.filter(l => l.id !== lobby.id);
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
                if (getPlayers(lobby).every(p => p.id.includes("-disconnected"))) {
                    lobbies = lobbies.filter(l => l.id !== lobby.id);
                }
                for (const action of lobby.randomActions) {
                    if (!action.seenPlayers.includes(player.name)) {
                        action.seenPlayers.push(player.name);
                    }
                }
            }
            io.emit("update-lobbies", lobbies);
            const socketTarget = io.sockets.sockets.get(targetId);
            if (socketTarget) {
                socketTarget.leave(lobby.id);
            }
        }
    }

    socket.on("request-update-selected-roles", (role) => {
        const lobby = findLobbyBySocketId();
        if (lobby) {
            const index = lobby.selectedRoles.findIndex(r => r.id === role.id);
            if (index > -1) {
                if (lobby.selectedRoles[index].name === "Alpha Wolf") {
                    lobby.cards = lobby.cards.filter(card => card.name !== "middle-card4");
                }
                lobby.selectedRoles.splice(index, 1);
            } else {
                let role1 = role;
                if (role.name === "Any Random") {
                    const roles = allRoles.filter(role2 => !lobby.selectedRoles.find(role3 => role2.id === role3.id) && !role2.name.includes("Random"));
                    role1 = roles.sort(() => Math.random() - 0.5)[0];
                    if (!role1) {
                        return;
                    }
                    role1.randomlyAdded = true;
                }
                lobby.selectedRoles.push(role1);
                if (!lobby.cards.find(card => card.name === "middle-card4") && lobby.selectedRoles.find(r => r.name === "Alpha Wolf")) {
                    lobby.cards.push(createCard(crypto.randomUUID(), "middle-card4"));
                }
            }
            io.to(lobby.id).emit("update-selected-roles", lobby);
        }
    });

    socket.on("request-update-selected-editions", (edition) => {
        const lobby = findLobbyBySocketId();
        if (lobby) {
            if (lobby.selectedEditions.find(e => e === edition)) {
                lobby.selectedEditions = lobby.selectedEditions.filter(e => e !== edition);
                lobby.selectedRoles = lobby.selectedRoles.filter(role => role.edition !== edition);
                if (edition === "daybreak") {
                    lobby.cards = lobby.cards.filter(card => card.name !== "middle-card4");
                }
            } else {
                lobby.selectedEditions.push(edition);
            }
            io.to(lobby.id).emit("update-selected-roles", lobby);
        }
    });

    socket.on("start-game", () => {
        const lobby = findLobbyBySocketId();
        if (lobby) {
            lobby.startTime = new Date();
            const roleNames = [];
            for (const role of lobby.selectedRoles) {
                roleNames.push(role.name);
            }
            if (!isTesting(lobby)) {
                roleNames.sort(() => Math.random() - 0.5);
            }

            for (const card of lobby.cards) {
                const role = card.name === "middle-card4" ? "Werewolf" : roleNames[0];
                const team = allRoles.find(role => role.name === result)?.team ?? "";
                card.role = role;
                card.team = team;
                card.roleChain.push(role);
                card.startingRole = role;
                card.mainAbility = role;
                card.viewableStartingRole = role;
                card.viewableStartingTeam = team;
                card.viewableCopycatRole = role;
                card.viewableCopycatTeam = team;

                if (card.name !== "middle-card4") {
                    roleNames.shift();
                }
            }
            const players = getPlayers(lobby);
            addRandomAction("Oracle", -9, [
                {text: "Would you like to turn into a Werewolf?", amount: 10},
                {text: "Would you like to exchange your card with one from the center?", amount: 20},
                {text: "Would you like to view the left center card?", amount: 10},
                {text: "Would you like to view the middle center card?", amount: 10},
                {text: "Would you like to view the right center card?", amount: 10}
            ]);
            const randomBlobActions = [];
            if (players.length === 3) {
                randomBlobActions.push({text: "Only the Blob itself is part of the Blob.", amount: 3});
            }
            if (players.length > 3) {
                if (players.length % 4 === 1) {
                    randomBlobActions.push({text: ((players.length - 1) / 4) + " players on each side of the Blob, are now part of the Blob.\nBlob keep them and yourself alive in order to win.", amount: 40});
                }
                randomBlobActions.push({text: "The " + Math.floor(players.length / 2 - 0.1) + " players to your left, are now part of the Blob.\nBlob keep them and yourself alive in order to win.", amount: 30});
                randomBlobActions.push({text: "The " + Math.floor(players.length / 2 - 0.1) + " players to your right, are now part of the Blob.\nBlob keep them and yourself alive in order to win.", amount: 30});
            }
            addRandomAction("Blob", 13, randomBlobActions);
            addRandomAction("Mortician", 13.1, [
                {text: "You may look at a card from yourself.", amount: 20},
                {text: "You may look at a card from the neighbor on your left.", amount: 20},
                {text: "You may look at a card from the neighbor on your right.", amount: 20},
                {text: "You may look at a card from one of your neighbors.", amount: 30},
                {text: "You may look at both cards from both of your neighbors.", amount: 10},
            ]);

            lobby.state = "look-at-role";
            io.emit("update-lobbies", lobbies);
        }
    });

    socket.on("update-state", (state) => {
        const lobby = findLobbyBySocketId();
        if (lobby) {
            lobby.state = state;
        }
        io.emit("update-lobbies", lobbies);
    });

    socket.on("reset-lobby", () => {
        const lobby = findLobbyBySocketId();
        if (lobby) {
            lobby.cards = lobby.cards.filter(player => !player.id.includes("-disconnected"));
            for (const card of lobby.cards) {
                resetCardState(card);
            }
            lobby.state = "waiting";
            lobby.pendingSwaps = [];
            lobby.winningTeam = "";
            lobby.voteResultText = "";
            lobby.randomActions = [];
            lobby.tempMessages = [];
            lobby.oracleAnswer = "";
            io.emit("update-lobbies", lobbies);
        }
    });

    socket.on("check-has-seen-role", () => {
        checkEveryoneHasSeenRole();
    });

    function checkEveryoneHasSeenRole() {
        const lobby = findLobbyBySocketId();
        if (lobby && lobby.state === "look-at-role") {
            lobby.cards.find(player => player.id === socket.id).hasSeenRole = true;
            const players = getPlayers(lobby);
            if (!players.every(player => player.hasSeenRole)) {
                updateLobby();
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
                lobby.displayText = "It is night time - " + formatTime(lobby.nightTimer);
                io.to(lobby.id).emit("update-lobbies", lobbies);

                const players = getPlayers(lobby);

                if (lobby.cards.find(card => card.isMiddleCard && card.roleChain[0] === "Oracle") && !lobby.oracleAnswer) {
                    if (lobby.nightTimer > 3 + Math.floor(Math.random() * 10)) {
                        const randomAnswers = ["yes", "no"];
                        if (lobby.randomActions.find(action => action.role === "Oracle").action.includes("Werewolf?")) {
                            randomAnswers.push("no", "no");
                        }
                        const randomOracleAnswer = randomAnswers.sort(() => Math.random() - 0.5)[0];
                        submitOracleAnswer(randomOracleAnswer);
                    }
                    return;
                }

                // manage swaps
                if (!swapsHappened) {
                    if (players.every(p => p.startingRole !== "Copycat" && p.startingRole !== "Alpha Wolf" && p.startingRole !== "Robber" && p.startingRole !== "Witch" &&
                        p.startingRole !== "Troublemaker" && p.startingRole !== "Village Idiot" && p.startingRole !== "Drunk"
                        && (p.roleChain[0] !== "Doppelganger" && (p.roleChain[0] !== "Copycat" || p.selectedCards[0]?.role !== "Doppelganger") ||
                            allRoles.find(role => role.name === p.startingRole)?.nightOrder >= 9) || p.hasClickedConfirm)) {
                        lobby.pendingSwaps.sort((a, b) => a.priority - b.priority);
                        for (const swap of lobby.pendingSwaps) {
                            swapCards(lobby, swap.swap);
                        }
                        swapsHappened = true;
                        players.forEach(p => p.mayDoLateAction = true);
                        io.to(lobby.id).emit("update-lobbies", lobbies);
                    }
                }
                if (!players.every(player => player.hasDoneNightAction)) {
                    return;
                }
                for (const player of players) {
                    for (const action of lobby.randomActions) {
                        if (!action.seenPlayers.includes(player.name)) {
                            return;
                        }
                    }
                    if (player.bumpedList.length > 0) {
                        return;
                    }
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
                        lobby.displayText = "It is now day time - " + formatTime(lobby.remainingDiscussTime);

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

    socket.on("has-clicked-ok-or-do-nothing", (hasClickedOk) => {
        const lobby = findLobbyBySocketId();
        if (lobby && lobby.state === "night") {
            const player = lobby.cards.find(player => player.id === socket.id);
            if ((player.roleChain[0] === "Doppelganger" || player.roleChain[0] === "Copycat") && !player.hasCopiedRole) {
                if (player.startingRole !== "Copycat" && player.startingRole !== "Doppelganger") {
                    player.hasCopiedRole = true;
                }
                player.sawWaitMessage = false;
                updateLobby();
                if (player.startingRole !== "Oracle") {
                    return;
                }
            }
            if ((player.startingRole === "Alpha Wolf" || player.startingRole === "Mystic Wolf") && !player.hasMetWerewolves &&
                player.roleChain[0] !== "Doppelganger" && (player.roleChain[0] !== "Copycat" || player.selectedCards[0]?.role !== "Doppelganger")) {
                player.hasMetWerewolves = true;
                updateLobby();
                return;
            }
            if ((player.startingRole === "Alpha Wolf" || player.startingRole === "Mystic Wolf") && !player.hasMetWerewolves && !player.hasDoneExtraWolfAction &&
                (player.roleChain[0] === "Doppelganger" || (player.roleChain[0] === "Copycat" || player.selectedCards[0]?.role === "Doppelganger"))) {
                player.hasDoneExtraWolfAction = true;
                updateLobby();
                return;
            }
            if (player.startingRole === "Witch" && !player.didFirstPart && hasClickedOk) {
                player.didFirstPart = true;
                updateLobby();
                return;
            }
            if (player.startingRole === "Paranormal Investigator" && player.team === "Villager" && !player.didFirstPart && hasClickedOk) {
                player.didFirstPart = true;
                updateLobby();
                return;
            }
            player.hasDoneNightAction = true;
            player.hasClickedConfirm = true;
            if (player.startingRole.toLowerCase().includes("wolf")) {
                player.hasMetWerewolves = true;
            }
            updateLobby();
        }
    });

    socket.on("set-has-voted", async (votedPlayerName) => {
        await checkEveryoneHasVoted(votedPlayerName);
    });

    async function checkEveryoneHasVoted(votedPlayerName) {
        const lobby = findLobbyBySocketId();
        if (lobby && lobby.state === "voting") {

            const players = getPlayers(lobby);
            lobby.cards.find(player => player.id === socket.id).vote = votedPlayerName;
            io.emit("update-lobbies", lobbies);
            if (!players.every(player => player.vote)) return;

            lobby.state = "voting-results";

            evaluateVotingResults(lobby, players);

            // database game storing
            if (!isTesting(lobby)) {
                await saveGameToDatabase(lobby);
            }

            io.emit("update-lobbies", lobbies);
            io.to(lobby.id).emit("everyone-voted");

            let lobbyCloseCount = 0;
            const lobbyCloseInterval = setInterval(() => {
                lobbyCloseCount++;
                if (lobby.state !== "voting-results") {
                    clearInterval(lobbyCloseInterval);
                }

                if (lobbyCloseCount > 60 * 10) { // after 10 minutes the lobby closes
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
        const lobby = findLobbyBySocketId();
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
                    if (player.roleChain[0] === "Oracle" && lobby.oracleAnswer.includes("go ahead") && player.roleChain.length === 1 ||
                        player.startingRole === "Copycat" || player.startingRole === "Doppelganger" || player.startingRole === "Alpha Wolf" && !player.hasDoneExtraWolfAction ||
                        player.startingRole === "Witch" && (player.witchHasViewedCard || player.didFirstPart) || player.startingRole === "Drunk" && !lobby.pendingSwaps.find(swap => swap.priority === 8) ||
                        !player.mayDoLateAction && allRoles.find(role => role.name === player.startingRole)?.nightOrder >= 9) {
                        player.hasDoneNightAction = false;
                        player.hasClickedConfirm = false;

                        if (player.startingRole === "Witch" && player.witchHasViewedCard) {
                            player.didFirstPart = true;
                        }
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
        const lobby = findLobbyBySocketId();
        if (lobby) {
            lobby.discussTime = discussTime;
            io.to(lobby.id).emit("update-select-roles-screen", lobby);
            io.to(lobby.id).emit("update-lobbies", lobbies);
        }
    });

    socket.on("skip-to-vote", () => {
        checkEveryoneHasSkippedToVote();
    });

    function checkEveryoneHasSkippedToVote() {
        const lobby = findLobbyBySocketId();
        if (lobby) {
            const players = getPlayers(lobby);
            const player = players.find(player => player.id === socket.id);
            if (player) {
                player.hasSkippedToVote = true;

                if (players.every(p => p.hasSkippedToVote)) {
                    lobby.remainingDiscussTime = 6;
                }
            }
        }
    }

    function sendMessage(playerSendMessage, message) {
        const lobby = findLobbyBySocketId();
        if (lobby) {
            const messageObject = {
                sender: !playerSendMessage ? "System" : lobby.cards.find(player => player.id === socket.id)?.name ?? "",
                message: message
            }
            lobby.messages.push(messageObject);
            lobby.tempMessages.push(messageObject);
            io.to(lobby.id).emit("receive-chat-message", messageObject);
        }
    }

    socket.on("send-chat-message", (message) => {
        sendMessage(true, message);
    });

    socket.on("send-console-message", (message) => {
        sendMessage(false, message);
    });

    socket.on("perform-swap", ({priority, swap}) => {
        const lobby = findLobbyBySocketId();
        if (lobby) {
            const cards = swap.map(swapItem => {
                const originalCard = lobby.cards.find(card => card.name === swapItem.name);
                return { ...originalCard };
            });
            for (let i = 0; i < swap.length; i++) {
                const currentCard = lobby.cards.find(card => card.name === swap[i].name);
                currentCard.viewableStartingRole = cards[(i + 1) % cards.length].role;
                currentCard.viewableStartingTeam = cards[(i + 1) % cards.length].team;
                if (swap[0].roleChain[0] === "Oracle" && priority === -9) {
                    currentCard.viewableCopycatRole = cards[(i + 1) % cards.length].role;
                    currentCard.viewableCopycatTeam = cards[(i + 1) % cards.length].team;
                }
            }
            swapCards(lobby, swap);

            // set Alpha Wolf has swapped to true
            const player = getPlayer();
            if (swap[0].name === "middle-card4" && player.startingRole === "Alpha Wolf") {
                player.hasDoneExtraWolfAction = true;
                updateLobby();
            }
        }
    });

    function swapCards(lobby, swap) {
        const cards = swap.map(swapItem => {
            const originalCard = lobby.cards.find(card => card.name === swapItem.name);
            return { ...originalCard };
        });
        for (let i = 0; i < swap.length; i++) {
            const currentCard = lobby.cards.find(card => card.name === swap[i].name);
            const nextCard = cards[(i + 1) % cards.length];

            currentCard.role = nextCard.role;
            currentCard.roleChain.push(currentCard.role);
            currentCard.team = nextCard.team;
            currentCard.mainAbility = nextCard.mainAbility;
        }
    }

    socket.on("turn-over-card", (name) => {
        getPlayer(name).isRevealed = true;
        updateLobby();
    });

    socket.on("has-clicked-confirm", ({selectedCards, oracleAnswer}) => {
        const lobby = findLobbyBySocketId();
        if (lobby && lobby.state === "night") {
            const player = lobby.cards.find(player => player.id === socket.id);
            if (player.hasClickedConfirm) {
                return;
            }
            if (selectedCards) {
                for (const card of selectedCards) {
                    player.selectedCards.push(card);
                }
            }
            player.hasClickedConfirm = true;
            if (oracleAnswer) {
                submitOracleAnswer(oracleAnswer);
            }
            if (player.roleChain[0] === "Oracle") {
                if (lobby.oracleAnswer.includes("turn into") && player.startingRole === "Werewolf" || lobby.oracleAnswer.includes("go ahead") ||
                    lobby.randomActions.find(action => action.role === "Oracle").action.includes("Would you like to view")) {
                    player.hasClickedConfirm = false;
                }
            }
            if ((player.startingRole === "Alpha Wolf" || player.startingRole === "Mystic Wolf") && !player.hasMetWerewolves) {
                player.hasClickedConfirm = false;
            }
            if (player.startingRole === "Paranormal Investigator") {
                player.team = player.selectedCards.at(-1).viewableStartingTeam;
                if (player.selectedCards.at(-1).viewableStartingRole === "Copycat" || player.selectedCards.at(-1).viewableStartingRole === "Doppelganger") {
                    player.team = "Villager";
                }
                if (!player.didFirstPart) {
                    player.hasClickedConfirm = false;
                }
                if (player.team !== "Villager" && player.team !== "Werewolf") {
                    player.team = player.roleChain[0] + "-" + player.team;
                }
                if (player.team !== "Villager") {
                    player.mainAbility = player.selectedCards.at(-1).viewableStartingRole;
                }
            }
            if (player.startingRole === "Witch" && !player.didFirstPart) {
                player.witchHasViewedCard = true;
                player.hasClickedConfirm = false;
            }
            if (player.startingRole === "Copycat" || player.startingRole === "Doppelganger") {
                if (player.startingRole === "Copycat" && player.selectedCards.at(-1).role === "Mortician") {
                    lobby.randomActions.find(action => action.role === "Mortician").seenPlayers.push(player.name);
                }
                if (player.startingRole === "Doppelganger" && player.selectedCards.at(-1).role === "Mortician") {
                    lobby.randomActions.find(action => action.role === "Doppelganger-Mortician").seenPlayers.push(player.name);
                }
                player.team = player.selectedCards.at(-1).team;
                if (player.team !== "Villager" && player.team !== "Werewolf") {
                    player.team = player.startingRole + "-" + player.team;
                }
                player.startingRole = player.selectedCards.at(-1).role;
                player.mainAbility = player.startingRole;
                player.hasClickedConfirm = false;
            }
            updateLobby();
        }
    });

    function isTesting(lobby) {
        return lobby.cards.find(p => p.name === "Bread1") && lobby.cards.find(p => p.name === "Bread2") && lobby.cards.find(p => p.name === "Bread3");
    }

    socket.on("saw-wait-message", () => {
        getPlayer().sawWaitMessage = true;
        updateLobby();
    });

    socket.on("set-is-sentinelled", (name) => {
        getPlayer(name).isSentinelled = true;
        updateLobby();
    });

    function getPlayer(name = "") {
        const lobby = findLobbyBySocketId();
        if (lobby) {
            const player = lobby.cards.find(player => player.id === socket.id);
            const player1 = lobby.cards.find(player => player.name === name);
            if (player && !name) {
                return player;
            }
            if (player1 && name) {
                return player1;
            }
        }
        return {};
    }

    function updateLobby() {
        const lobby = findLobbyBySocketId();
        if (lobby) {
            io.to(lobby.id).emit("update-lobbies", lobbies);
        }
    }

    socket.on("confirm-seen-random-action", () => {
        const lobby = findLobbyBySocketId();
        if (lobby) {
            const player = lobby.cards.find(player => player.id === socket.id);
            if (player) {
                for (const action of lobby.randomActions) {
                    if (!action.seenPlayers.includes(player.name)) {
                        action.seenPlayers.push(player.name);
                        updateLobby();
                        return;
                    }
                }
                if (player.bumpedList.length > 0) {
                    player.bumpedList = [];
                    updateLobby();
                }
            }
        }
    });

    function addRandomAction(roleName = "", nightOrder = 20, randomActions = [{text: "Nothing", amount: 2}]) {
        const lobby = findLobbyBySocketId();
        if (lobby.selectedRoles.find(role => role.name === roleName)) {
            const array = [];
            for (const randomAction of randomActions) {
                for (let i = 0; i < randomAction.amount; i++) {
                    array.push(randomAction.text);
                }
            }
            array.sort(() => Math.random() - 0.5);
            lobby.randomActions.push({
                nightOrder: nightOrder,
                role: roleName,
                action: array[0],
                seenPlayers: roleName !== "Oracle" && roleName !== "Blob" ? [lobby.cards.find(card => card.role === roleName).name] : []
            });

            if (roleName !== "Oracle" && roleName !== "Blob" && lobby.selectedRoles.find(role => role.name === "Doppelganger")) {
                lobby.randomActions.push({
                    nightOrder: nightOrder + 0.01,
                    role: "Doppelganger-" + roleName,
                    action: array[1],
                    seenPlayers: []
                });
            }
        }
    }

    function submitOracleAnswer(answer) {
        const lobby = findLobbyBySocketId();
        if (lobby) {
            const oracleAction = lobby.randomActions.find(action => action.role === "Oracle");
            if (oracleAction.action.includes("turn into a Werewolf?")) {
                if (answer === "yes") {
                    lobby.oracleAnswer = "Congratulations the Oracle card is now a Werewolf card!";
                    const card = lobby.cards.find(card => card.roleChain[0] === "Oracle");
                    if (card) {
                        card.role = "Werewolf";
                        card.roleChain.push("Werewolf");
                        card.team = "Werewolf";
                        card.viewableStartingRole = "Werewolf";
                        card.viewableStartingTeam = "Werewolf";
                        card.startingRole = "Werewolf";
                    }
                }
                if (answer === "no") {
                    lobby.oracleAnswer = "Ok, the Oracle stays on the Villager team!";
                }
            }
            if (oracleAction.action.includes("like to exchange")) {
                if (answer === "yes") {
                    lobby.oracleAnswer = "Ok Oracle, go ahead and exchange your card with one from the center!";
                }
                if (answer === "no") {
                    lobby.oracleAnswer = "Ok the Oracle, keeps their card!";
                }
            }
            if (oracleAction.action.includes("center card?")) {
                if (answer === "yes") {
                    lobby.oracleAnswer = "Ok Oracle, you may view the " + oracleAction.action.split("the ")[1].split(" ")[0] + " center card";
                }
                if (answer === "no") {
                    const randomOracleAnswer = [1, 2, 3].sort(() => Math.random() - 0.5)[0];
                    if (randomOracleAnswer === 1) {
                        lobby.oracleAnswer = "Ok, then you don´t look at it.";
                    }
                    if (randomOracleAnswer === 2) {
                        lobby.oracleAnswer = "You may look at one of the other center cards instead.";
                    }
                    if (randomOracleAnswer === 3) {
                        lobby.oracleAnswer = "You may look at two other center cards instead.";
                    }
                }
            }
        }
    }

    socket.on("thing-bump", ({thing, bumped}) => {
        const lobby = findLobbyBySocketId();
        if (lobby) {
            const thingPlayer = lobby.cards.find(p => p.name === thing.name);
            const bumpedPlayer = lobby.cards.find(p => p.name === bumped.name);
            bumpedPlayer.bumpedList.push(thingPlayer.name);
        }
    });
});

function setAllRoles(roles) {
    allRoles = roles;
}

server.listen(3003,"0.0.0.0", async () => {
    console.log("Access game on https://bread-005.github.io/wherewolf-app/index.html");
    await connectDatabase();
});

export {setAllRoles};