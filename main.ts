import * as openaiClient from './myOpenAi';
import express from 'express';

const app = express();

//server static in public folder
app.use(express.static('public'));

app.post('/chat', async (req, res) => {
    await openaiClient.initChat();
});

app.get('/chat/init', async (req, res) => {
    res.send(openaiClient.getInitMessages());
});


app.post('/chat/send', async (req, res) => {

    const allMessages = req.body;
    const completion = await openaiClient.completeMessages(allMessages);
    await openaiClient.createMp3FromText(completion || 'Il sembleque je n\'ai pas de réponse à vous donner, je suis désolé.');

    res.send(completion);
});

app.get('/chat/complete/mp3', async (req, res) => {
    res.sendFile(openaiClient.TMP_AUDIO_FILE);
});

