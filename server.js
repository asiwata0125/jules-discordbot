require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis'); // NEW
const { verifyKeyMiddleware, InteractionType, InteractionResponseType } = require('discord-interactions'); // NEW

// Configuration
const PORT = process.env.PORT || 8080; // Cloud Run default
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const JULES_API_KEY = process.env.JULES_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY; // Needed for interactions

const PROJECT_ID = process.env.PROJECT_ID; // e.g. 'my-project'
const SERVICE_NAME = process.env.SERVICE_NAME; // e.g. 'jules-bot'
const REGION = process.env.REGION; // e.g. 'us-central1'

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const run = google.run('v2'); // Cloud Run API

// State
const activeSessions = new Map(); // channelId -> sessionId

// --- Google Cloud Run Manager ---
class GoogleCloudManager {
    static async getAuthClient() {
        const auth = new google.auth.GoogleAuth({
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });
        return await auth.getClient();
    }

    static async setMinInstances(count) {
        if (!PROJECT_ID || !SERVICE_NAME || !REGION) {
            console.log("Cloud Run env vars missing, skipping scaling.");
            return;
        }

        console.log(`Setting min-instances to ${count}...`);
        try {
            const authClient = await this.getAuthClient();
            const name = `projects/${PROJECT_ID}/locations/${REGION}/services/${SERVICE_NAME}`;
            
            // 1. Get current config to preserve other settings
            const request = {
                name,
                auth: authClient
            };
            // Note: In v2 API, we patch the service.
            // We need to construct the patch request carefully.
            
            // Simplified: We assume we just want to update scaling. 
            // We use the `updateService` method, but typically needs the full object or a mask.
            // Let's use `patch` with updateMask.
            
            const patchRequest = {
                name,
                updateMask: 'template.scaling.minInstanceCount',
                requestBody: {
                    template: {
                        scaling: {
                            minInstanceCount: count
                        }
                    }
                },
                auth: authClient
            };

            await run.projects.locations.services.patch(patchRequest);
            console.log(`Successfully set min-instances to ${count}`);

        } catch (err) {
            console.error("Failed to scale Cloud Run:", err);
            // Don't crash app, just log
        }
    }
}

// ... (Jules API Helpers source helpers logic remains same, removed for brevity in this replace call, will keep if I don't touch them? 
// Wait, I must be careful not to delete them. I will use Start/End line to preserve them.)

// ...

// --- Express Server & Interactions ---
const app = express();

// Interaction Endpoint (Slash Commands)
app.post('/interactions', verifyKeyMiddleware(DISCORD_PUBLIC_KEY), async (req, res) => {
    const message = req.body;

    if (message.type === InteractionType.PING) {
        return res.send({ type: InteractionResponseType.PONG });
    }

    if (message.type === InteractionType.APPLICATION_COMMAND) {
        const commandName = message.data.name;

        if (commandName === 'wake') {
            console.log("Received /wake command");
            res.send({
                type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                data: {
                    content: '🥱 Waking up... (This will take about a minute. I will start listening to chat soon!)',
                    flags: 64 // Ephemeral
                }
            });
            
            // Trigger Scaling
            await GoogleCloudManager.setMinInstances(1);

            // Connect Gateway
            if (!client.isReady()) {
                console.log("Logging in to Discord Gateway...");
                client.login(DISCORD_TOKEN).catch(console.error);
            }
            return;
        }

        if (commandName === 'sleep') {
            console.log("Received /sleep command");
            res.send({
                type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                data: {
                    content: '😴 Going to sleep... Goodnight!',
                    flags: 64 // Ephemeral
                }
            });

            // Trigger Sleep Logic
            await GoogleCloudManager.setMinInstances(0);
            
            // Optional: Destroy client connection to ensure process can idle out if Cloud Run logic permits
            // client.destroy(); 
            return;
        }
    }
});

// Health Check
app.get('/', (req, res) => {
    res.send({ status: 'running', bot_ready: client.isReady() });
});

app.listen(PORT, () => {
    console.log(`Express server running on port ${PORT}`);
});



// Note: We need to preserve the Jules helpers and Client logic.
// I will target the TOP of the file to inject imports/config/classes,
// and the BOTTOM to inject the Express listeners.

// This tool call REPLACES imports and config.


// ... (Jules API Helpers source helpers remain the same ...)

async function identifySourceWithGemini(userMessage, sources) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const sourcesList = sources.map((s, i) => `${i + 1}. ${s.githubRepo ? `${s.githubRepo.owner}/${s.githubRepo.repo}` : s.name}`).join('\n');
    
    const prompt = `
    You are a setup assistant for a coding bot. 
    The user wants to start a session but needs to select a source repository first.
    
    Available Sources:
    ${sourcesList}
    
    User Message: "${userMessage}"
    
    Task:
    1. If the user's message clearly identifies a specific source (by name, number, or description like "the chat app"), return the index (0-based) of that source.
    2. If the user's message is generic (e.g. "hi", "start", "help me code") or ambiguous, generate a polite, conversational reply asking them to specify which repository to work on. List the options in your reply naturally.
    3. If the user asks a general question not related to coding or sources, try to guide them to pick a source first.

    Return ONLY raw JSON (no markdown formatting):
    {
        "matchIndex": number | null,
        "reply": string | null
    }
    `;

    try {
        const result = await model.generateContent(prompt);
        const responseText = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(responseText);
    } catch (err) {
        console.error("Gemini Error:", err);
        return { matchIndex: null, reply: "I'm having trouble thinking right now. Please tell me the repository number (e.g. '1')." }; // Fallback
    }
}


// ... (Discord Client setup remains ...)

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const isMentioned = message.mentions.users.has(client.user.id);
    const isDM = !message.guild;

    if (!isMentioned && !isDM) return;

    let content = message.content.replace(/<@!?[0-9]+>/g, '').trim();
    if (!content) content = "Hello"; 

    const channelId = message.channel.id;
    await message.channel.sendTyping();

    try {
        let sessionId = activeSessions.get(channelId);
        let replyText = "";

        // Case 1: Active Session exists -> Direct simple chat with Jules
        if (sessionId) {
            console.log(`Using existing session ${sessionId}`);
            try {
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

        // Case 2: No Session -> Use Gemini to identify source
        } else {
            console.log(`No active session. engaging Gemini for setup.`);
            
            // 1. List Sources
            const sourcesData = await listSources();
            if (!sourcesData.sources || sourcesData.sources.length === 0) {
                await message.reply("I couldn't find any connected sources in your Jules account. Please connect a source first.");
                return;
            }

            const sources = sourcesData.sources;
            
            // 2. Ask Gemini
            const decision = await identifySourceWithGemini(content, sources);

            if (decision.matchIndex !== null && decision.matchIndex >= 0 && decision.matchIndex < sources.length) {
                // Source Identified!
                const selectedSource = sources[decision.matchIndex];
                await message.reply(`Okay, loading **${selectedSource.name.split('/').pop()}**...`);
                
                // 3. Create Session
                const sessionData = await createSessionFull(selectedSource, content);
                sessionId = sessionData.name;
                
                if (!sessionId) throw new Error("Session creation failed.");
                activeSessions.set(channelId, sessionId);

                // 4. Get Agent Response
                replyText = await waitForAgentResponse(sessionId, channelId);
                if (!replyText) replyText = "Session started. Ready to help!";
                
            } else {
                // Ambiguous or Clarification needed
                // Gemini provided the reply text
                await message.reply(decision.reply || "Which repository would you like to work on?");
                return; // User needs to reply again
            }
        }

        if (replyText) {
            await message.reply(replyText);
        } else {
             if (sessionId) {
                 await message.channel.send("Jules is thinking... (Response timed out, check back later)");
             }
        }

    } catch (err) {
        console.error("Handler Error:", err);
        await message.reply(`Error: ${err.message}`);
    }
});


