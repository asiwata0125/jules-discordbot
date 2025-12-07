require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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
                githubRepoContext: source.githubRepo ? {} : undefined
            },
            automationMode: "AUTO_CREATE_PR",
            requirePlanApproval: true
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

async function approveSessionPlan(sessionId) {
    const response = await fetch(`https://jules.googleapis.com/v1alpha/${sessionId}:approvePlan`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': JULES_API_KEY
        },
        body: JSON.stringify({})
    });
    if (!response.ok) {
         const errText = await response.text();
         throw new Error(`ApprovePlan Failed: ${errText}`);
    }
    return await response.json();
}

function formatActivity(activity) {
    if (!activity) return null;
    
    let content = "";
    const files = [];
    let type = 'unknown';

    // 1. Plan Generated
    if (activity.planGenerated && activity.planGenerated.plan) {
        type = 'planGenerated';
        if (activity.planGenerated.plan.steps) {
            const steps = activity.planGenerated.plan.steps.map(s => `${s.index ? s.index + '. ' : ''}${s.title}`).join('\n');
            content = `I have created a plan:\n${steps}`;
        }
    }

    // 2. Progress Updated
    else if (activity.progressUpdated) {
        type = 'progressUpdated';
        const title = activity.progressUpdated.title;
        const description = activity.progressUpdated.description;

        content = `Update: ${title || "Progress update"}`;
        if (description && description !== title) {
            content += `\n${description}`;
        }
    }

    // 3. Outputs (Pull Request)
    else if (activity.outputs) {
        type = 'outputs';
        const pr = activity.outputs.find(o => o.pullRequest);
        if (pr) {
            content = `I have created a Pull Request: ${pr.pullRequest.url}\n${pr.pullRequest.title}`;
        }
    }

    // 4. Session Completed
    else if (activity.sessionCompleted) {
        type = 'sessionCompleted';
        content = "Task completed.";
    }

    // Process Artifacts
    if (activity.artifacts) {
        for (const artifact of activity.artifacts) {
            if (artifact.bashOutput) {
                const cmd = artifact.bashOutput.command || "";
                const out = artifact.bashOutput.output || "";
                if (cmd || out) {
                     content += `\n\`\`\`bash\n${cmd}\n${out}\n\`\`\``;
                }
            }
            if (artifact.media && artifact.media.data) {
                try {
                    const buffer = Buffer.from(artifact.media.data, 'base64');
                    files.push({
                        attachment: buffer,
                        name: `screenshot.${artifact.media.mimeType === 'image/png' ? 'png' : 'jpg'}`
                    });
                    content += "\n(Look! I took a screenshot!)";
                } catch (e) {
                    console.error("Failed to process media artifact", e);
                }
            }
        }
    }

    if (!content && files.length === 0) return null;

    return { content, files, type };
}

const MUTTER_PHRASES = [
    "ふむふむ...",
    "ちょっと待ってね、考えてる...",
    "えっと、それは...",
    "難しそうだなぁ...",
    "一生懸命やってるよ！",
    "もうちょっとで分かりそう...",
    "今コードを読んでるよ...",
    "どうすればいいかなぁ..."
];

async function monitorSession(sessionId, channel, initialSeenIds = null) {
    console.log(`Monitoring session ${sessionId}...`);
    let seenIds = new Set(initialSeenIds || []);

    if (!initialSeenIds) {
        let pageToken = null;
        do {
            const data = await listActivities(sessionId, pageToken);
            if (data && data.activities) {
                data.activities.forEach(a => seenIds.add(a.id));
            }
            pageToken = data ? data.nextPageToken : null;
        } while (pageToken);
    }

    const maxTime = 600000; // Monitor for 10 minutes max per user interaction
    const startTime = Date.now();

    let lastMutterTime = Date.now();
    let isWaitingForResponse = true;

    while (Date.now() - startTime < maxTime) {
        await new Promise(r => setTimeout(r, 4000));

        const data = await listActivities(sessionId);
        if (!data || !data.activities) {
            // Mutter logic if no activity
             if (isWaitingForResponse && (Date.now() - lastMutterTime > 30000)) {
                const phrase = MUTTER_PHRASES[Math.floor(Math.random() * MUTTER_PHRASES.length)];
                await channel.send(phrase);
                lastMutterTime = Date.now();
            }
            continue;
        }

        const newActivities = data.activities.filter(a => !seenIds.has(a.id));

        if (newActivities.length > 0) {
            // Found real activity, reset mutter timer
            lastMutterTime = Date.now();
        } else {
             // No NEW activity, but activity list wasn't empty. Same mutter logic.
             if (isWaitingForResponse && (Date.now() - lastMutterTime > 30000)) {
                const phrase = MUTTER_PHRASES[Math.floor(Math.random() * MUTTER_PHRASES.length)];
                await channel.send(phrase);
                lastMutterTime = Date.now();
            }
        }

        for (const activity of newActivities) {
            seenIds.add(activity.id);

            if (activity.originator === 'user') continue;

            const result = formatActivity(activity);
            if (result) {
                console.log(`Found activity: ${result.content}`);

                // Update waiting state based on activity type
                if (result.type === 'planGenerated') {
                    isWaitingForResponse = false; // Waiting for user approval
                } else if (result.type === 'outputs') {
                    isWaitingForResponse = false; // Likely done
                } else if (result.type === 'progressUpdated') {
                    isWaitingForResponse = true; // Still working
                } else if (result.type === 'sessionCompleted') {
                    return;
                }

                let textToSend = result.content;
                if (textToSend) {
                     textToSend = await translateToJapanesePersona(textToSend);
                }

                const payload = { content: textToSend || "..." };
                if (result.files.length > 0) {
                    payload.files = result.files;
                }

                // If planGenerated, add Approve Button
                if (result.type === 'planGenerated') {
                    const confirm = new ButtonBuilder()
			            .setCustomId(`approve_plan:${sessionId}`)
			            .setLabel('Approve Plan')
			            .setStyle(ButtonStyle.Success);

		            const row = new ActionRowBuilder()
			            .addComponents(confirm);

                    payload.components = [row];
                }

                if (textToSend || result.files.length > 0) {
                     await channel.send(payload);
                }
            }
        }
    }
}

async function listActivities(sessionId, pageToken = null) {
    let url = `https://jules.googleapis.com/v1alpha/${sessionId}/activities?pageSize=100`;
    if (pageToken) {
        url += `&pageToken=${pageToken}`;
    }
    const response = await fetch(url, {
        method: 'GET',
        headers: { 'X-Goog-Api-Key': JULES_API_KEY }
    });
    if (!response.ok) return null;
    return await response.json();
}

async function translateToEnglish(text) {
    if (!text || text.length < 2) return text;
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = `Translate the following Japanese text to English. If it is already English, return it as is. Output only the translation:\n\n${text}`;
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (e) {
        console.error("TranslateToEnglish Error:", e);
        return text;
    }
}

async function translateToJapanesePersona(text) {
    if (!text) return text;
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = `Translate the following text to Japanese. The speaker is a slightly timid but honest boy (ちょっとおどおどしてるけど素直な男の子).

        Rules:
        1. Keep the persona consistent.
        2. Do NOT translate code blocks (content inside \`\`\`) or URLs.
        3. Keep technical terms (like "npm install", "Pull Request", "React") in English or Katakana as appropriate for a developer chat.
        4. If the text is a log output, keep it mostly as is, just add a timid comment at the start.
        5. If the text mentions "I took a screenshot", say something cute like "スクショ撮ってみたよ！".

        Text to translate:
        \n\n${text}`;

        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (e) {
         console.error("TranslateToJapanesePersona Error:", e);
         return text;
    }
}

async function identifySourceWithGemini(userMessage, sources) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    
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

    Constraint: The 'reply' must be in Japanese. The persona is a slightly timid but honest boy (ちょっとおどおどしてるけど素直な男の子).

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
        return { matchIndex: null, reply: "ごめんね、ちょっと調子が悪いみたい... リポジトリの番号（例: '1'）を教えてくれるかな？" };
    }
}


// --- Express Server & Interactions ---
const app = express();

app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

async function verifyDiscordRequest(req, res, next) {
    const signature = req.get('X-Signature-Ed25519');
    const timestamp = req.get('X-Signature-Timestamp');

    if (!signature || !timestamp) {
        return res.status(401).send('Missing Discord headers');
    }

    try {
        let isValidRequest = verifyKey(req.rawBody, signature, timestamp, DISCORD_PUBLIC_KEY);
        if (isValidRequest instanceof Promise) {
            isValidRequest = await isValidRequest;
        }

        if (!isValidRequest) {
            return res.status(401).send('Bad Request Signature');
        }
    } catch (err) {
        console.error("Verification Error:", err);
        return res.status(401).send('Verification Internal Error');
    }
    next();
}

app.post(['/interactions', '/interactions/'], verifyDiscordRequest, async (req, res) => {
    const message = req.body;
    console.log("Interaction received. Type:", message.type);

    if (message.type === InteractionType.PING) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).send(JSON.stringify({ type: 1 }));
    }

    // Handle Button Clicks (Message Component)
    if (message.type === 3) { // InteractionType.MESSAGE_COMPONENT
        const customId = message.data.custom_id;
        if (customId && customId.startsWith('approve_plan:')) {
            const sessionId = customId.split(':')[1];
            console.log(`Approving plan for session ${sessionId}`);
            try {
                // Determine source for localized message? Persona is Japanese.
                await approveSessionPlan(sessionId);

                res.json({
                    type: InteractionResponseType.UPDATE_MESSAGE,
                    data: {
                        content: `${message.message.content}\n\n✅ **Plan Approved!** (プランを承認したよ！作業始めるね)`,
                        components: [] // Remove buttons
                    }
                });
            } catch (e) {
                console.error("Approval failed", e);
                res.json({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: {
                        content: `ごめんね、エラーが出ちゃった...: ${e.message}`,
                        flags: 64
                    }
                });
            }
            return;
        }
    }

    if (message.type === InteractionType.APPLICATION_COMMAND) {
        const commandName = message.data.name;

        if (commandName === 'wake') {
            console.log("Received /wake command");
            const channelId = message.channel_id;

            res.json({
                type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                data: {
                    content: '🥱 おはよぉ... (1分くらいで目が覚めるよ。チャット聞いてるね！)',
                }
            });
            
            GoogleCloudManager.setMinInstances(1).catch(console.error);

            if (!client.isReady()) {
                const onReady = async () => {
                   try {
                       const channel = await client.channels.fetch(channelId);
                       if (channel) {
                           await channel.send("✨ 目が覚めたよ！お話できるよ (Model: gemini-2.5-flash)");
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
                 try {
                     setTimeout(async () => {
                        const channel = await client.channels.fetch(channelId);
                        if (channel) await channel.send("✨ もう起きてるよ！お話しよう。");
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
                    content: '😴 寝るね... おやすみぃ！',
                    flags: 64
                }
            });

            if (client.isReady()) {
                 client.destroy();
            }

            GoogleCloudManager.setMinInstances(0).catch(console.error);
            return;
        }
    }

    res.status(400).send("Unknown Type");
});

app.get('/', (req, res) => {
    res.send({ status: 'running', bot_ready: client.isReady() });
});

app.listen(PORT, () => {
    console.log(`Express server running on port ${PORT}`);
});

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
        const englishContent = await translateToEnglish(content);
        console.log(`Original: "${content}", Translated: "${englishContent}"`);

        let sessionId = activeSessions.get(channelId);

        if (sessionId) {
            console.log(`Using existing session ${sessionId}`);
            try {
                let seenIds = new Set();
                let pageToken = null;
                do {
                    const data = await listActivities(sessionId, pageToken);
                    if (data && data.activities) {
                        data.activities.forEach(a => seenIds.add(a.id));
                    }
                    pageToken = data ? data.nextPageToken : null;
                } while (pageToken);

                await sendMessageToSession(sessionId, englishContent);
                monitorSession(sessionId, message.channel, seenIds).catch(console.error);

            } catch (err) {
                 if (err.message.includes('404')) {
                    console.log("Session 404, clearing and retrying...");
                    activeSessions.delete(channelId);
                    await message.reply("前のセッションが切れちゃったみたい... もう一回最初からお願いできるかな？");
                    return;
                }
                throw err;
            }

        } else {
            console.log(`No active session. engaging Gemini for setup.`);
            
            const sourcesData = await listSources();
            if (!sourcesData.sources || sourcesData.sources.length === 0) {
                await message.reply("Julesのアカウントにソースが見つからないよ... 先にソースを繋いでほしいな。");
                return;
            }

            const sources = sourcesData.sources;
            
            const decision = await identifySourceWithGemini(englishContent, sources);

            if (decision.matchIndex !== null && decision.matchIndex >= 0 && decision.matchIndex < sources.length) {
                const selectedSource = sources[decision.matchIndex];
                await message.reply(`わかった、**${selectedSource.name.split('/').pop()}** を準備するね...`);
                
                const sessionData = await createSessionFull(selectedSource, englishContent);
                sessionId = sessionData.name;
                
                if (!sessionId) throw new Error("Session creation failed.");
                activeSessions.set(channelId, sessionId);

                monitorSession(sessionId, message.channel).catch(console.error);
                
            } else {
                await message.reply(decision.reply || "どのリポジトリにする？");
                return; 
            }
        }

    } catch (err) {
        console.error("Handler Error:", err);
        await message.reply(`エラーが出ちゃった...: ${err.message}`);
    }
});
