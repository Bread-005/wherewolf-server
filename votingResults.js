function appendWinResult(lobby, team, text) {
    const canAppend = lobby.winningTeam.length > 0 && lobby.winningTeam !== "No-one";
    if (canAppend) {
        lobby.winningTeam += " and " + team;
        lobby.voteResultText += " and " + text[0].toLowerCase() + text.slice(1);
    } else {
        lobby.winningTeam = team;
        lobby.voteResultText = text;
    }
}

function evaluateVotingResults(lobby, players) {

    // check Cursed Transform three times because Doppelganger-Cursed and Copycat-Cursed
    for (let i = 0; i < 3; i++) {
        for (const player of players) {
            if (player.mainAbility === "Cursed") {
                for (const player1 of players) {
                    if (player1.mainAbility.toLowerCase().includes("wolf") && player1.vote === player.name) {
                        player.role = "Werewolf";
                        player.team = "Werewolf";
                        player.roleChain.push("Werewolf");
                    }
                }
            }
        }
    }

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

    for (const player of players) {
        if (player.mainAbility === "Prince") {
            player.voteAmount = 0;
        }
        if (player.mainAbility === "Bodyguard") {
            players.find(p => p.name === player.vote).voteAmount = 0;
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

        for (const player of players) {
            if (player.mainAbility === "Bodyguard") {
                players.find(p => p.name === player.vote).dies = false;
            }
        }

        // check Hunter deaths three times because Doppelganger-Hunter and Copycat-Hunter
        for (let i = 0; i < 3; i++) {
            for (const player of players) {
                if (player.mainAbility === "Hunter") {
                    players.find(p => p.name === player.vote).dies = true;

                    for (const player of players) {
                        if (player.mainAbility === "Bodyguard") {
                            players.find(p => p.name === player.vote).dies = false;
                        }
                    }
                }
            }
        }
    }

    if (players.find(player => player.mainAbility.toLowerCase().includes("wolf"))) {
        lobby.voteResultText = "No werewolves died.";
        lobby.winningTeam = "Werewolf";

        if (players.find(p => (p.mainAbility.toLowerCase().includes("wolf")) && p.dies)) {
            lobby.voteResultText = "a werewolf died.";
            lobby.winningTeam = "Villager";
        }
    }

    if (!players.find(player => player.mainAbility.toLowerCase().includes("wolf"))) {
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
        if (players.find(p => p.role === "Squire" && !p.dies)) {
            lobby.voteResultText = "The Squire survived";
            lobby.winningTeam = "Werewolf";
        }
        if (players.find(p => p.role === "Minion" && p.dies)) {
            lobby.voteResultText = "The Minion died";
            lobby.winningTeam = "Villager";
        }
        if (players.find(p => p.role === "Squire" && p.dies)) {
            lobby.voteResultText = "The Squire died";
            lobby.winningTeam = "Villager";
        }
        lobby.voteResultText += " and there are no werewolves.";
    }

    // evaluate if Tanner has won
    for (const player of players) {
        if (player.dies) {
            if (player.team.includes("Tanner") && player.mainAbility !== "Apprentice Tanner" ||
                player.mainAbility === "Apprentice Tanner" && !players.find(p => p.team.includes("Tanner") && p.mainAbility !== "Apprentice Tanner")) {
                if (lobby.winningTeam.includes("Werewolf")) {
                    lobby.voteResultText = "";
                    lobby.winningTeam = "";
                }
                appendWinResult(lobby, player.team, "The " + player.team + " died.");
            }
        }
    }

    // evaluate if Mortician has won
    for (const player of players) {
        if (player.team.includes("Mortician")) {
            const myIndex = players.findIndex(p => p.id === player.id);
            const leftNeighbor = players[(myIndex + 1) % players.length];
            const rightNeighbor = players[(myIndex - 1 + players.length) % players.length];

            if (leftNeighbor.dies || rightNeighbor.dies) {
                appendWinResult(lobby, player.team, "One of " + player.name + "'s neighbors died.")
            }
        }
    }

    // evaluate if Blob has won
    const blobAction = lobby.randomActions.find(action => action.role === "Blob");
    if (blobAction) {
        const actionText = blobAction.action.toLowerCase();
        for (const player of players) {
            if (player.team.includes("Blob")) {
                const blobIndex = players.findIndex(p => p.id === player.id);
                const blobPlayers = new Set();
                blobPlayers.add(player);

                let leftCount = 0;
                let rightCount = 0;

                if (actionText.includes("each side")) {
                    leftCount = parseInt(actionText.split(" ")[0]);
                    rightCount = parseInt(actionText.split(" ")[0]);
                }
                if (actionText.includes("left")) {
                    leftCount = parseInt(actionText.split(" ")[1]);
                }
                if (actionText.includes("right")) {
                    rightCount = parseInt(actionText.split(" ")[1]);
                }

                for (let i = 1; i <= leftCount; i++) {
                    const index = (blobIndex + i) % players.length;
                    blobPlayers.add(players[index]);
                }
                for (let i = 1; i <= rightCount; i++) {
                    const index = (blobIndex - i + players.length) % players.length;
                    blobPlayers.add(players[index]);
                }

                if (Array.from(blobPlayers).every(p => !p.dies)) {
                    appendWinResult(lobby, player.team, "All players in " + player.name + "'s Blob survived.");
                }
            }
        }
    }

    // evaluate if Sly Fox has won
    for (const player of players) {
        if (player.team.includes("Sly Fox") && player.voteAmount === 0) {
            if (lobby.winningTeam.includes("Sly Fox")) {
                lobby.winningTeam += " and " + player.team;
            } else {
                lobby.winningTeam = player.team;
                lobby.voteResultText = "The Sly Fox received 0 votes.";
            }
        }
    }
}

export {evaluateVotingResults};