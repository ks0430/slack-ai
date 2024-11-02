const { App, ExpressReceiver } = require('@slack/bolt');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('@notionhq/client');
require('dotenv').config();
// Constants for context management
const MAX_CONTEXT_LENGTH = 4096;
const conversationContexts = new Map();

// Initialize Notion client
const notion = new Client({
    auth: process.env.NOTION_API_KEY,
});

const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Create a custom ExpressReceiver
const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Initialize the Slack app with the custom receiver
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: false, // Make sure this is false for HTTP mode
    appToken: process.env.SLACK_APP_TOKEN // Optional, only needed if using Socket Mode
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

// Add this function to detect if a message contains a new idea
async function isNewIdea(text) {
    if (currentAI === 'gpt') {
        const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{
                role: 'system',
                content: 'You are a helpful assistant that determines if a message contains a new idea or proposal. Respond with only "true" or "false".'
            }, {
                role: 'user',
                content: `Does this message contain a new idea or proposal? Message: "${text}"`
            }],
            max_tokens: 10,
        });
        return completion.choices[0].message.content.trim().toLowerCase() === 'true';
    } else {
        const completion = await anthropic.completions.create({
            model: 'claude-2',
            prompt: `Human: Does this message contain a new idea or proposal? Respond with only "true" or "false". Message: "${text}"\nAssistant:`,
            max_tokens_to_sample: 10,
        });
        return completion.completion.trim().toLowerCase() === 'true';
    }
}

// Add this function to create a Notion page
async function createNotionTicket(text, userId) {
    try {
        const response = await notion.pages.create({
            parent: {
                database_id: NOTION_DATABASE_ID,
            },
            properties: {
                Title: {
                    title: [
                        {
                            text: {
                                content: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
                            },
                        },
                    ],
                },
                Status: {
                    select: {
                        name: 'New',
                    },
                },
                Source: {
                    rich_text: [
                        {
                            text: {
                                content: `Slack User: ${userId}`,
                            },
                        },
                    ],
                },
            },
            children: [
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [
                            {
                                text: {
                                    content: text,
                                },
                            },
                        ],
                    },
                },
            ],
        });
        
        return `https://notion.so/${response.id.replace(/-/g, '')}`;
    } catch (error) {
        console.error('Error creating Notion ticket:', error);
        throw error;
    }
}

// Listen for messages in channels the bot is added to
app.message(async ({ message, say }) => {
    try {
        console.log('Received message:', message.text);
        let response;
        
        // Update conversation context
        const context = updateConversationContext(message.user, {
            role: 'user',
            content: message.text
        });

        // Check if message contains a new idea
        const containsNewIdea = await isNewIdea(message.text);
        let notionUrl = null;
        
        if (containsNewIdea) {
            notionUrl = await createNotionTicket(message.text, message.user);
        }

        // Get AI response
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

        // Add Notion URL to response if applicable
        if (notionUrl) {
            response += `\n\nI've created a Notion ticket for your idea: ${notionUrl}`;
        }

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
    try {
        const port = process.env.PORT || 3000;
        await app.start(port);
        console.log(`⚡️ Bolt app is running on port ${port}!`);
    } catch (error) {
        console.error('Error starting app:', error);
        process.exit(1);
    }
})(); 
