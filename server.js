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

const pendingSourceSelections = new Map(); // channelId -> { sources: [], originalPrompt: string }

    try {
        let sessionId = activeSessions.get(channelId);
        let pendingSelection = pendingSourceSelections.get(channelId);
        let replyText = "";

        // Case 1: Active Session exists -> Continue chat
        if (sessionId) {
            console.log(`Using existing session ${sessionId}`);
            try {
                // If it's a "reset" command, maybe handle that? (Future work)
                await sendMessageToSession(sessionId, content);
                replyText = await waitForAgentResponse(sessionId, channelId);
            } catch (err) {
                 if (err.message.includes('404')) {
                    console.log("Session 404, clearing and retrying...");
                    activeSessions.delete(channelId);
                    await message.reply("Previous session expired. Please start again.");
                    return;
                }
                throw err;
            }
        
        // Case 2: Pending Source Selection -> Handle User Choice
        } else if (pendingSelection) {
            const choice = parseInt(content.trim());
            const sources = pendingSelection.sources;

            if (isNaN(choice) || choice < 1 || choice > sources.length) {
                await message.reply(`Please enter a number between 1 and ${sources.length}.`);
                return;
            }

            const selectedSource = sources[choice - 1];
            const originalPrompt = pendingSelection.originalPrompt;

            // Clear pending state
            pendingSourceSelections.delete(channelId);

            await message.reply(`Project **${selectedSource.name.split('/').pop()}** selected. Initializing session...`);

            // Create Session using the ORIGINAL prompt
            const sessionData = await createSessionFull(selectedSource, originalPrompt);
            console.log("Session Created:", JSON.stringify(sessionData));
            
            sessionId = sessionData.name;
             if (!sessionId) {
                throw new Error("Session ID is missing in response.");
            }
            activeSessions.set(channelId, sessionId);

            // Wait for response (assuming the creation prompt triggers the first thought)
            // If createSession uses 'prompt' to START, does it create an 'agent' activity?
            // Usually yes.
            replyText = await waitForAgentResponse(sessionId, channelId);

            // If no immediate response from creation, we might need to send the prompt again?
            // But we just sent it.
            // Let's rely on polling. If return null, we say "Session started".
            if (!replyText) {
                 replyText = "Session started. (Waiting for Jules to act...)";
            }

        // Case 3: No Session & No Pending -> Start New Flow
        } else {
            console.log(`No active session for channel ${channelId}. Listing sources.`);
            
            // 1. List Sources
            const sourcesData = await listSources();
            if (!sourcesData.sources || sourcesData.sources.length === 0) {
                await message.reply("I couldn't find any connected sources in your Jules account. Please connect a source first.");
                return;
            }

            const sources = sourcesData.sources;
            
            // Store state and ask user
            pendingSourceSelections.set(channelId, { sources: sources, originalPrompt: content });

            let listMsg = "**Select a source to start a session:**\n";
            sources.forEach((s, index) => {
                // Simple name parsing: sources/github/user/repo -> user/repo
                // or just show the full name or generic ID
                const displayName = s.githubRepo ? `${s.githubRepo.owner}/${s.githubRepo.repo}` : s.name;
                listMsg += `${index + 1}. ${displayName}\n`;
            });
            listMsg += "\nReply with the number.";
            
            await message.reply(listMsg);
            return; // Wait for next user message
        }

        if (replyText) {
            await message.reply(replyText);
        } else {
             // Only if we expected a reply and got none (time out)
             if (sessionId && !pendingSelection) { // logic complex here, simplified check
                 await message.channel.send("Jules is thinking... (Response timed out, check back later)");
             }
        }


    } catch (err) {
        console.error("Handler Error:", err);
        await message.reply(`Error: ${err.message}`);
    }
});

client.login(DISCORD_TOKEN);
