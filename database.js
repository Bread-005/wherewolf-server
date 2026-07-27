import {setAllRoles} from "./server.js";
import "dotenv/config";
import {MongoClient} from "mongodb";

const connectionString = "mongodb+srv://" + process.env.DATABASE_USERNAME + ":" + process.env.DATABASE_PASSWORD + "@cluster0.rwh4ibp.mongodb.net/?retryWrites=true&w=majority";
const client = new MongoClient(connectionString);
let database;

async function connectDatabase() {
    try {
        await client.connect();
        database = client.db("Wherewolf");
        setAllRoles(await fetch("https://raw.githubusercontent.com/Bread-005/wherewolf-app/main/roles.json").then(res => res.json()));
        console.log("MongoDB connected");
    }
    catch (error) {
        console.error("MongoDB Connection Error", error);
    }
}

async function saveGameToDatabase(lobby) {
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
                voteAmount: lobby.cards.filter(card1 => card1.vote === card.name).length,
                isAlive: !card.dies,
                selectedCards: card.selectedCards.map(card => card.name),
                marks: [] // card.markChain
            }
        }),
        winningTeams: lobby.winningTeam,
        discussTime: lobby.discussTime,
        nightLength: lobby.nightTimer,
        messages: lobby.tempMessages,
        randomActions: lobby.randomActions.map(action => {
            return {
                role: action.role,
                action: action.action
            }
        }),
        startTime: lobby.startTime,
        endTime: new Date()
    });
}

/**
 * Persists the current in-memory lobbies array to MongoDB so it survives a server restart.
 */
async function saveActiveLobbies(lobbies) {
    const connection = database.collection("active_lobbies");
    await connection.updateOne(
        {_id: "active_lobbies"},
        {$set: {lobbies: lobbies}},
        {upsert: true}
    );
}

/**
 * Loads the previously persisted lobbies array so the server can restore its state after a restart.
 */
async function loadActiveLobbies() {
    const connection = database.collection("active_lobbies");
    const document = await connection.findOne({_id: "active_lobbies"});
    return document?.lobbies ?? [];
}

export {connectDatabase, saveGameToDatabase, saveActiveLobbies, loadActiveLobbies};