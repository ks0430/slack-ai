const { App, ExpressReceiver } = require('@slack/bolt');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

// Constants for context management
const MAX_CONTEXT_LENGTH = 4096;
const conversationContexts = new Map();

// Create a custom ExpressReceiver
const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Initialize the Slack app with the custom receiver
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver: receiver,
});

// Initialize the OpenAI API client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Initialize the Anthropic client
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

// Track current AI model
let currentAI = 'gpt';

// Function to manage conversation context
function updateConversationContext(userId, newMessage) {
    let userContext = conversationContexts.get(userId) || [];
    userContext.push(newMessage);
    
    // Calculate total length of context
    let totalLength = userContext.reduce((sum, msg) => sum + msg.content.length, 0);
    
    // Remove oldest messages if context exceeds max length
    while (totalLength > MAX_CONTEXT_LENGTH && userContext.length > 1) {
        const removedMessage = userContext.shift();
        totalLength -= removedMessage.content.length;
    }
    
    conversationContexts.set(userId, userContext);
    return userContext;
}

// Handle the challenge request
receiver.router.post('/slack/events', (req, res) => {
    if (req.body.type === 'url_verification') {
        res.send({ challenge: req.body.challenge });
    } else {
        console.log('Received event:', req.body);
        res.sendStatus(200);
    }
});

// Function to get channel history
async function getChannelHistory(channelId, count = 10) {
    try {
        const result = await app.client.conversations.history({
            token: process.env.SLACK_BOT_TOKEN,
            channel: channelId,
            limit: count,
        });
        return result.messages;
    } catch (error) {
        console.error("Error fetching channel history:", error);
        return [];
    }
}

// Listen for messages in channels the bot is added to
app.message(async ({ message, say }) => {
    try {
        console.log('Received message:', message.text);
        let response;
        
        const context = updateConversationContext(message.user, {
            role: 'user',
            content: message.text
        });

        if (currentAI === 'gpt') {
            const completion = await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: context,
                max_tokens: 150,
            });
            response = completion.choices[0].message.content.trim();
        } else {
            // Convert context to Anthropic format
            const conversationHistory = context
                .map(msg => `${msg.role === 'user' ? 'Human' : 'Assistant'}: ${msg.content}`)
                .join('\n');
            
            const completion = await anthropic.completions.create({
                model: 'claude-2',
                prompt: `${conversationHistory}\nAssistant:`,
                max_tokens_to_sample: 150,
            });
            response = completion.completion.trim();
        }

        // Update context with AI's response
        updateConversationContext(message.user, {
            role: 'assistant',
            content: response
        });

        console.log('Generated response:', response);
        await say(response);
    } catch (error) {
        console.error('Error processing message:', error);
        await say('Sorry, there was an error processing your request.');
    }
});

// Handle /summarize command
app.command('/summarize', async ({ command, ack, say }) => {
    await ack();
    try {
        const messages = await getChannelHistory(command.channel_id, 20);
        const messageTexts = messages.map(m => m.text).reverse().join("\n");
        const prompt = `Please summarize the following conversation:\n\n${messageTexts}\n\nSummary:`;
        let summary;

        if (currentAI === 'gpt') {
            const completion = await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 150,
            });
            summary = completion.choices[0].message.content.trim();
        } else {
            const completion = await anthropic.completions.create({
                model: 'claude-2',
                prompt: `Human: ${prompt}\nAssistant:`,
                max_tokens_to_sample: 150,
            });
            summary = completion.completion.trim();
        }

        await say(`Recent conversation summary (using ${currentAI.toUpperCase()}):\n${summary}`);
    } catch (error) {
        console.error("Error processing summarize command:", error);
        await say("Sorry, there was an error summarizing the messages.");
    }
});

// Handle /clear_context command
app.command('/clear_context', async ({ command, ack, say }) => {
    await ack();
    conversationContexts.delete(command.user_id);
    await say('Conversation context has been cleared.');
});

// Add back the /switch_ai command handler
app.command('/switch_ai', async ({ command, ack, say }) => {
    await ack();
    currentAI = currentAI === 'gpt' ? 'claude' : 'gpt';
    await say(`AI model switched to ${currentAI.toUpperCase()}`);
});

// Start the app
(async () => {
    await app.start(process.env.PORT || 3000);
    console.log('⚡️ Bolt app is running!');
})(); 