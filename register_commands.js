require('dotenv').config();
const { REST, Routes } = require('discord.js');

const commands = [
    {
        name: 'wake',
        description: 'Wake up the bot (Starts the Cloud Run instance)',
    },
    {
        name: 'sleep',
        description: 'Put the bot to sleep (Stops the Cloud Run instance to save money)',
    },
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        // CLIENT_ID is needed. We can get it from decoding the token part, OR ask user.
        // Actually, usually in .env as CLIENT_ID or APPLICATION_ID.
        // If not in .env, we might fail.
        // Let's assume user put it in .env or we log a warning.
        
        const CLIENT_ID = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID;

        if (!CLIENT_ID) {
            console.error("Error: DISCORD_CLIENT_ID or CLIENT_ID is missing in .env file.");
            console.error("Please add it to .env file. (It's your Application ID from Discord Portal)");
            process.exit(1);
        }

        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();
