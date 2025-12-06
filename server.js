require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Configuration
const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ... (Configuration)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

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

client.login(DISCORD_TOKEN);
