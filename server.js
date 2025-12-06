require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Configuration
const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const JULES_API_KEY = process.env.JULES_API_KEY;

// Jules API Endpoints
const JULES_BASE_URL = 'https://jules.googleapis.com/v1alpha';

// State
// In a real production app, use a database. For this demo, we use in-memory.
// map: channelId -> sessionId
const activeSessions = new Map();

// --- Express Server for Render Health Check ---
const app = express();

app.get('/', (req, res) => {
    res.send('Jules Discord Bot is running!');
});

app.listen(PORT, () => {
    console.log(`Express server running on port ${PORT}`);
});

// --- Jules API Helpers ---

async function listSources() {
    const response = await fetch(`${JULES_BASE_URL}/sources`, {
        headers: {
            'X-Goog-Api-Key': JULES_API_KEY
        }
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to list sources: ${response.status} ${text}`);
    }
    return response.json();
}

async function createSession(sourceName, prompt) {
    const body = {
        prompt: prompt,
        sourceContext: {
            source: sourceName,
             // Default to generic context usage; assuming 'main' or similar might be inferred or not strictly required if only source is passed?
            // The API docs usage example showed sourceContext structure.
            // Let's rely on the structure from the docs:
            // "sourceContext": { "source": "sources/...", "githubRepoContext": { "startingBranch": "main" } }
            // We might need to fetch the source details to know if it's a github repo.
            // For simplicity, we will pass just the "source" field if the API allows, or try to copy structure.
            // Documentation implies we need to pass sourceContext. 
            // Let's assume the source object from listSources gives us enough info or we can construct a minimal valid context.
        },
        title: `Discord Session - ${new Date().toISOString()}`
    };

    // Correcting sourceContext based on Docs: 
    // The docs example is specific about githubRepoContext. 
    // If the source is a github repo, we probably need that.
    // Let's look at what listSources returns.
    // { "sources": [ { "name": "sources/...", "githubRepo": { ... } } ] }
    // We should probably just pass the source name and let the server defaults handle it if possible, 
    // OR we need to inspect the source type.
    // For this MVP, let's assume we copy the structure if it's a github repo.
    
    // However, since we don't have the source object here (passed mainly name), 
    // let's adjust the caller to pass the full source object.
}

async function createSessionFull(sourceObj, prompt) {
    const payload = {
        prompt: prompt,
        sourceContext: {
            source: sourceObj.name,
        },
        title: `Discord Session - ${Date.now()}`
    };

    if (sourceObj.githubRepo) {
        payload.sourceContext.githubRepoContext = {
            startingBranch: 'main' // safe default?
        };
    }

    const response = await fetch(`${JULES_BASE_URL}/sessions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': JULES_API_KEY
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to create session: ${response.status} ${text}`);
    }
    return response.json();
}

async function sendMessageToSession(sessionId, message) {
    const url = `${JULES_BASE_URL}/${sessionId}:sendMessage`;
    console.log(`POSTing to ${url}`);
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': JULES_API_KEY
        },
        body: JSON.stringify({ prompt: message })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to send message: ${response.status} ${text}`);
    }
    return response.json();
}

async function listActivities(sessionId) {
    const response = await fetch(`${JULES_BASE_URL}/${sessionId}/activities?pageSize=10`, { // Fetch recent
        headers: {
            'X-Goog-Api-Key': JULES_API_KEY
        }
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to list activities: ${response.status} ${text}`);
    }
    return response.json();
}

// Track last seen activity ID per channel/session to avoid duplicates
const lastSeenActivityIds = new Map(); // channelId -> activityIdString

async function waitForAgentResponse(sessionId, channelId) {
    const maxRetries = 15; // Wait up to ~30 seconds (15 * 2s)
    const interval = 2000;

    for (let i = 0; i < maxRetries; i++) {
        await new Promise(resolve => setTimeout(resolve, interval));
        console.log(`Polling activities for ${sessionId}... attempt ${i+1}`);

        const data = await listActivities(sessionId);
        if (!data.activities || data.activities.length === 0) continue;

        // Sort by createTime? API usually returns ordered? 
        // Docs don't specify sort order clearly, but seemingly chronological or reverse.
        // Let's assume the API returns list, we probably want the *latest* 'agent' activity.
        // We filter for originator == 'agent'.
        
        const agentActivities = data.activities.filter(a => a.originator === 'agent');
        
        if (agentActivities.length === 0) continue;

        // Look for the most recent one we haven't seen.
        // We'll trust the order in the list or check createTime if needed.
        // Let's assume index 0 is newest or check timestamps. 
        // Ideally we parse createTime.
        agentActivities.sort((a, b) => new Date(b.createTime) - new Date(a.createTime)); // Descending

        const latestActivity = agentActivities[0];
        
        const lastSeenId = lastSeenActivityIds.get(channelId);
        
        if (latestActivity.id !== lastSeenId) {
            // New activity found!
            lastSeenActivityIds.set(channelId, latestActivity.id);
            
            // Extract text
            let text = "";
            if (latestActivity.progressUpdated) {
                text = latestActivity.progressUpdated.description || latestActivity.progressUpdated.title;
            } else if (latestActivity.planGenerated) {
                text = "I've generated a plan: " + (latestActivity.planGenerated.plan.steps.map(s => s.title).join('\n') || "Check the dashboard.");
            } else if (latestActivity.sessionCompleted) {
                text = "Session completed.";
            } else {
                continue; // Skip activities with no displayable text (like strict internal ones?)
            }

            if (text) return text;
        }
    }
    return null; // Timeout
}

// --- Discord Client ---

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    // Ignore bots
    if (message.author.bot) return;

    // Simple robust command handling or just chat
    // For a DM or mentions, we could be more specific, but for now respond to all in allowed channels?
    // Let's restrict to only when mentioned OR DMs? 
    // User asked "Discord bot that can talk with Jules".
    // Let's assume any message in a channel the bot is in, or maybe just mentions.
    // Let's do mentions to be polite.
    
    const isMentioned = message.mentions.users.has(client.user.id);
    const isDM = !message.guild;

    if (!isMentioned && !isDM) return;

    // Remove mention from content
    let content = message.content.replace(/<@!?[0-9]+>/g, '').trim();
    if (!content) content = "Hello"; // default greeting

    const channelId = message.channel.id;
    
    // Indicate typing
    await message.channel.sendTyping();

    try {
        let sessionId = activeSessions.get(channelId);
        let replyText = "";

        if (!sessionId) {
            console.log(`No active session for channel ${channelId}. Creating new one.`);
            
            // 1. List Sources
            const sourcesData = await listSources();
            if (!sourcesData.sources || sourcesData.sources.length === 0) {
                await message.reply("I couldn't find any connected sources in your Jules account. Please connect a source first.");
                return;
            }

            // 2. Pick first source (User can be more specific in v2)
            const source = sourcesData.sources[0];
            console.log(`Selected source: ${source.name}`);

            // 3. Create Session
            // Use the user's message as the initial prompt
            const sessionData = await createSessionFull(source, content);
            sessionId = sessionData.name; // "sessions/..."
            activeSessions.set(channelId, sessionId);
            
            // The creation response might contain the first answer? 
            // Docs say: "The immediate response will look something like this... prompt: 'Create a boba app!'"
            // It doesn't seem to return the *agent's text response* immediately in the session object, 
            // it usually returns the session metadata.
            // We usually need to list activities or wait for an event?
            // Actually, usually `sendMessage` returns the response.
            // `createSession` just initializes.
            
            // If createSession doesn't trigger a turn, we might need to send the message again?
            // But we passed the prompt in createSession.
            // Let's check if we need to fetch the initial response.
            // The `outputs` field in session object might have something?
            // Or maybe we treat the first message as "Context setting" and just say "Session started".
            // Let's try to `sendMessage` immediately if the creation prompt implies a question.
            
            // Actually, for a chat bot, we usually want:
            // User: "Hi" -> Create Session -> Bot: "Hi, how can I help?"
            // If we use "Hi" as the prompt for creation, the agent "processes" it.
            // We need to get the agent's reply.
            // Does `createSession` return the activities/activities list?
            // Probably not.
            
            // Strategy: 
            // 1. Create session with prompt.
            // 2. Wait a moment? Or List Activities?
            // The docs for `sendMessage` say it returns the response? No, it returns the user message resource usually?
            // "Here is an example of a ListActivities response." -> implies we might need to poll or list activities.
            
            // WAIT. `sendMessage` documentation isn't fully shown in the chunks I read.
            // Let's assume we need to list activities to get the response, OR `sendMessage` returns it.
            // Most Google Agent APIs (like Vertex AI) return the response in the call.
            // But this might be async.
            // Let's assume we need to `sendMessage` to *talk*.
            // If `createSession` takes a prompt, that's just the 'task description'.
        await message.reply(`Error: ${err.message}`);
    }
});

client.login(DISCORD_TOKEN);
