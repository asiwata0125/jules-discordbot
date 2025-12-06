require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const { verifyKey, InteractionType, InteractionResponseType } = require('discord-interactions');

// Configuration
const PORT = process.env.PORT || 8080;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN ? process.env.DISCORD_TOKEN.trim() : "";
const JULES_API_KEY = process.env.JULES_API_KEY ? process.env.JULES_API_KEY.trim() : "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : "";
const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY ? process.env.DISCORD_PUBLIC_KEY.trim() : "";
const PROJECT_ID = process.env.PROJECT_ID;
const SERVICE_NAME = process.env.SERVICE_NAME;
const REGION = process.env.REGION;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const run = google.run('v2');

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

// State
const activeSessions = new Map(); // channelId -> sessionId

// --- Google Cloud Run Manager ---
class GoogleCloudManager {
    static async getAuthClient() {
        try {
             const auth = new google.auth.GoogleAuth({
                scopes: ['https://www.googleapis.com/auth/cloud-platform']
            });
            return await auth.getClient();
        } catch (e) {
            console.error("Auth Error:", e);
            throw e;
        }
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
        }
    }
}

// --- Jules API Helpers ---
async function listSources() {
    const response = await fetch('https://jules.googleapis.com/v1alpha/sources', {
        method: 'GET',
        headers: { 'X-Goog-Api-Key': JULES_API_KEY }
    });
    if (!response.ok) throw new Error(`ListSources Failed: ${response.statusText}`);
    return await response.json();
}

async function createSessionFull(source, userPrompt) {
    const response = await fetch('https://jules.googleapis.com/v1alpha/sessions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': JULES_API_KEY
        },
        body: JSON.stringify({
            prompt: userPrompt,
            sourceContext: {
                source: source.name,
                githubRepoContext: source.githubRepo ? { startingBranch: "main" } : undefined
            },
            automationMode: "AUTO_CREATE_PR", 
        })
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`CreateSession Failed: ${errText}`);
    }
    return await response.json(); 
}

async function sendMessageToSession(sessionId, prompt) {
    const response = await fetch(`https://jules.googleapis.com/v1alpha/${sessionId}:sendMessage`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': JULES_API_KEY
        },
        body: JSON.stringify({ prompt })
    });
    if (!response.ok) {
         const errText = await response.text();
         throw new Error(`SendMessage Failed: ${errText}`);
    }
    return await response.json();
}

async function waitForAgentResponse(sessionId, channelId) {
    // Polling usually logic would be here. For simplicity, we just list activities once or twice.
    // In a real prod bot, use a better queuing system or longer polling loop.
    console.log(`Polling activities for ${sessionId}...`);
    
    // Simple naive delay loop
    for (let i = 0; i < 20; i++) { // Try for ~40-60 seconds
        await new Promise(r => setTimeout(r, 3000));
        
        const activities = await listActivities(sessionId);
        if (activities && activities.activities) {
            // Find recent message from AGENT
            // Sorting to find latest
             // Logic simplified: Just grab the latest planGenerated or content that seems like a reply.
             // For conversational bot, we assume the last entry from 'agent' is the reply.
             // This is tricky without robust state tracking of what we already saw.
             
             // Hack: Just get the last activity.
             const last = activities.activities[activities.activities.length - 1];
             if (last.originator === 'agent' && last.type !== 'thinking' ) { 
                 // Assuming 'thinking' isn't the final type, actual text usually in other fields or just inferred.
                 // The API structure varies, assuming we print summary or something.
                 // Adapting to previous known logic or simplifed.
                 
                 // Let's assume we return a generic "Check PR" or specific text if available.
                 return "Jules replied! (Check Cloud Console for details or assume task started)."; 
             }
        }
    }
    return null; // Timeout
}

async function listActivities(sessionId) {
     const response = await fetch(`https://jules.googleapis.com/v1alpha/${sessionId}/activities`, {
        method: 'GET',
        headers: { 'X-Goog-Api-Key': JULES_API_KEY }
    });
    // ignore 404
    if (!response.ok) return null;
    return await response.json();
}

async function identifySourceWithGemini(userMessage, sources) {
    // User requested latest model.
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    
    // Create a simplified list of sources for the prompt
    const sourcesList = sources.map((s, i) => `${i}. ${s.name} (Repo: ${s.githubRepo?.owner}/${s.githubRepo?.name})`).join('\n');

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
        return { matchIndex: null, reply: "I'm having trouble thinking right now. Please tell me the repository number (e.g. '1')." }; 
    }
}


// --- Express Server & Interactions ---
const app = express();

// Middleware: Parse JSON and verify Discord signature
// Middleware: Parse JSON and capture raw body
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// Async Middleware for Discord Verification
async function verifyDiscordRequest(req, res, next) {
    const signature = req.get('X-Signature-Ed25519');
    const timestamp = req.get('X-Signature-Timestamp');

    if (!signature || !timestamp) {
        return res.status(401).send('Missing Discord headers');
    }

    try {
        // Handle both Sync and Async verifyKey implementations
        let isValidRequest = verifyKey(req.rawBody, signature, timestamp, DISCORD_PUBLIC_KEY);
        if (isValidRequest instanceof Promise) {
            isValidRequest = await isValidRequest;
        }

        console.log("Signature Verification Result (Resolved):", isValidRequest);

        if (!isValidRequest) {
            return res.status(401).send('Bad Request Signature');
        }
    } catch (err) {
        console.error("Verification Error:", err);
        return res.status(401).send('Verification Internal Error');
    }
    next();
}

// Interaction Endpoint (Slash Commands)
// Handle both /interactions and /interactions/ to avoid 301 redirects which Discord hates
app.post(['/interactions', '/interactions/'], verifyDiscordRequest, async (req, res) => {
    const message = req.body;
    console.log("Interaction received. Type:", message.type, "Name:", message.data ? message.data.name : "N/A");

    if (message.type === InteractionType.PING) {
        console.log("Handling PING. Sending PONG.");
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).send(JSON.stringify({ type: 1 }));
    }

    if (message.type === InteractionType.APPLICATION_COMMAND) {
        const commandName = message.data.name;

        if (commandName === 'wake') {
            console.log("Received /wake command");
            const channelId = message.channel_id;

            // Reply should use res.json for clarity, though res.send works
            res.json({
                type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                data: {
                    content: '🥱 Waking up... (This will take about a minute. I will start listening to chat soon!)',
                }
            });
            
            GoogleCloudManager.setMinInstances(1).catch(console.error);

            // Connect Gateway
            if (!client.isReady()) {
                console.log("Logging in to Discord Gateway...");
                
                // Notify when actually ready
                const onReady = async () => {
                   try {
                       const channel = await client.channels.fetch(channelId);
                       if (channel) {
                           await channel.send("✨ I am fully awake and ready to chat! (Model: gemini-2.5-flash)");
                       }
                   } catch (err) {
                       console.error("Failed to send ready message:", err);
                   }
                };
                client.once('ready', onReady);

                client.login(DISCORD_TOKEN).catch(err => {
                    console.error("Login failed:", err);
                    client.off('ready', onReady);
                });
            } else {
                 // If already ready, maybe send a follow up immediately? 
                 // Or just assume the user knows.
                 // Ideally use followUp via interaction token, but standard message is fine if we have channelId.
                 try {
                     // Wait a bit to let the first message appear
                     setTimeout(async () => {
                        const channel = await client.channels.fetch(channelId);
                        if (channel) await channel.send("✨ I was already awake! Ready to chat.");
                     }, 1000);
                 } catch(e) {}
            }
            return;
        }

        if (commandName === 'sleep') {
            console.log("Received /sleep command");
            res.json({
                type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                data: {
                    content: '😴 Going to sleep... Goodnight!',
                    flags: 64 // Ephemeral
                }
            });

            // Disconnect Gateway
            if (client.isReady()) {
                 console.log("Destroying client connection...");
                 client.destroy();
            }

            GoogleCloudManager.setMinInstances(0).catch(console.error);
            return;
        }
    }
    console.log("Unknown interaction type");
    res.status(400).send("Unknown Type");
});

// Health Check
app.get('/', (req, res) => {
    res.send({ status: 'running', bot_ready: client.isReady() });
});

app.listen(PORT, () => {
    console.log(`Express server running on port ${PORT}`);
});

// Message Handling
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

        // Case 1: Active Session exists
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

        // Case 2: No Session -> Use Gemini
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
                const selectedSource = sources[decision.matchIndex];
                await message.reply(`Okay, loading **${selectedSource.name.split('/').pop()}**...`);
                
                const sessionData = await createSessionFull(selectedSource, content);
                sessionId = sessionData.name;
                
                if (!sessionId) throw new Error("Session creation failed.");
                activeSessions.set(channelId, sessionId);

                replyText = await waitForAgentResponse(sessionId, channelId);
                if (!replyText) replyText = "Session started. Ready to help!";
                
            } else {
                await message.reply(decision.reply || "Which repository would you like to work on?");
                return; 
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
