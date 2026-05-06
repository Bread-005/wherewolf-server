function evaluateVotingResults(lobby, players) {

    // check Cursed Transform three times because Doppelganger-Cursed and Copycat-Cursed
    for (let i = 0; i < 3; i++) {
        for (const player of players) {
            if (player.role === "Cursed" || player.secondaryRole === "Cursed") {
                for (const player1 of players) {
                    if ((player1.role.toLowerCase().includes("wolf") || player1.secondaryRole.toLowerCase().includes("wolf")) && player1.vote === player.name) {
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
        if (player.role === "Prince" || player.secondaryRole === "Prince") {
            player.voteAmount = 0;
        }
        if (player.role === "Bodyguard" || player.secondaryRole === "Bodyguard") {
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
            if (player.role === "Bodyguard" || player.secondaryRole === "Bodyguard") {
                players.find(p => p.name === player.vote).dies = false;
            }
        }

        // check Hunter deaths three times because Doppelganger-Hunter and Copycat-Hunter
        for (let i = 0; i < 3; i++) {
            for (const player of players) {
                if (player.role === "Hunter" || player.secondaryRole === "Hunter") {
                    players.find(p => p.name === player.vote).dies = true;

                    for (const player of players) {
                        if (player.role === "Bodyguard" || player.secondaryRole === "Bodyguard") {
                            players.find(p => p.name === player.vote).dies = false;
                        }
                    }
                }
            }
        }
    }

    if (players.find(player => player.role.toLowerCase().includes("wolf"))) {
        if (!players.find(player => player.team.includes("Tanner") && player.dies)) {
            lobby.voteResultText = "No werewolves died.";
            lobby.winningTeam = "Werewolf";
        }

        if (players.find(p => p.role.toLowerCase().includes("wolf") && p.dies)) {
            lobby.voteResultText = "a werewolf died.";
            lobby.winningTeam = "Villager";
        }
    }

    if (!players.find(player => player.role.toLowerCase().includes("wolf"))) {
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

    // evaluate if Tanner has won
    for (const player of players) {
        if (player.dies) {
            if (player.team.includes("Tanner")) {
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

    // evaluate if Mortician has won
    for (const player of players) {
        if (player.team.includes("Mortician")) {
            const myIndex = players.findIndex(p => p.id === player.id);
            const leftNeighbor = players[(myIndex + 1) % players.length];
            const rightNeighbor = players[(myIndex - 1 + players.length) % players.length];

            if (leftNeighbor.dies || rightNeighbor.dies) {
                if (lobby.winningTeam.length > 0 && lobby.winningTeam !== "No-one") {
                    lobby.winningTeam += " and " + player.team;
                    lobby.voteResultText += " and one of " + player.name + "'s neighbors died.";
                } else {
                    lobby.winningTeam = player.team;
                    lobby.voteResultText = "One of " + player.name + "'s neighbors died.";
                }
            }
        }
    }
}

export {evaluateVotingResults};