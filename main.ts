import * as openaiClient from './myOpenAi';
import express from 'express';
import bodyParser from 'body-parser';

var rootPath = __dirname;
const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;


app.get('/chat/init', async (req, res) => {
    res.send(openaiClient.getInitMessages());
});


app.post('/chat/send', async (req, res) => {
    const allMessages = req.body.messages;
    const completion = await openaiClient.completeMessages(allMessages);
    await openaiClient.createMp3FromText(completion || 'Il semble que je n\'ai pas de réponse à vous donner, je suis désolé.');

    res.send(completion);
});

app.post('/chat', async (req, res) => {
    await openaiClient.initChat();
});

app.get('/chat/complete/mp3/*', async (req, res) => {
    res.sendFile(__dirname + '/' + openaiClient.TMP_AUDIO_FILE);
    //delete file afterwards
});

app.use(express.static('public'));

app.listen(PORT, () => {
    console.log('Server started on http://localhost:3000');
});