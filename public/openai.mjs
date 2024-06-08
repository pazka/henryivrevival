import { displayState, interpretAnswer,STATES } from "./sceance.mjs";

export async function sendTextToServer(text, audio) {
    displayState(STATES.THINKING);
    const res = await fetch('/chat/send', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages: [...allMessages, { role: 'user', content: text }] })
    }).catch((error) => {
        console.error('Error:', error);
        res.status = 500;
    });

    //if success play mp3
    //play mp3 from server
    if (res.status === 200) {
        let gptAnswer = await res.text();
        appendMessages(text, gptAnswer);
        interpretAnswer(gptAnswer);
    }
}

var allMessages = []

export async function appendMessages(userText,responseText) {
    allMessages.push({ role: 'user', content: userText });
    allMessages.push({ role: 'assistant', content: responseText });
}

export async function initChat() {

    //init chat from openai messages
    fetch('/chat/init')
        .then(response => response.json())
        .then(data => {
            allMessages = data;
            console.log(allMessages);
        });
}