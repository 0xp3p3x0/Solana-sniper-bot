import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import logger from '../utils/logger';

dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN!, { polling: true });

// bot.on('message', (msg) => {
//   console.log(chatId);
//   bot.sendMessage(chatId, 'Received your message');
// });

export const sendMessage = (text: string) => {
  bot.sendMessage(Number(process.env.CHAT_ID!), text);
};