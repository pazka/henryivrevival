
import { startSpeechRecognition, stopSpeechRecognition } from './speech.mjs';

//make a popup so the user interact with the webpage

function makeInteraction() {
    var popupWrapper = document.createElement("div");
    var popup = document.createElement("div");
    var title = document.createElement("h1");
    var button = document.createElement("button");

    popupWrapper.id = "popupWrapper";
    popup.id = "popup";
    title.id = "popupTitle";
    button.id = "popupButton";

    title.innerHTML = "Bienvenue sur le site de la séance de spiritisme";
    button.innerHTML = "Commencer";

    popup.appendChild(title);
    popup.appendChild(button);
    //add classes
    popupWrapper.classList.add("popup-wrapper");
    popupWrapper.appendChild(popup);
    popup.classList.add("popup");
    document.body.appendChild(popupWrapper);

    button.onclick = function () {
        popupWrapper.style.display = "none";
        displayState("APPARITION");
    }

}
makeInteraction();

export const STATES = { 'INIT': 'INIT', 'APPARITION': 'APARTION', 'LISTENING': 'LSTN', 'EARING': 'EARING', 'THINKING': 'THNK', 'TALKING': 'TLK', 'GOODBYE': 'BYE' };

export function displayState(desiredState) {
    console.log("trying to display state", desiredState, "from", currentState)


    if (currentState === STATES.INIT && desiredState !== STATES.APPARITION) {
        console.log("cannot go from init to", desiredState);
        return;
    }

    if (currentState === STATES.GOODBYE && desiredState === STATES.LISTENING) {
        desiredState = STATES.INIT;
        return;
    }

    if (currentState !== STATES.LISTENING && desiredState === STATES.EARING) {
        return;
    }

    currentState = desiredState;
    switch (desiredState) {
        case STATES.INIT:
            document.getElementById('init_2').classList.remove('active');
            document.getElementById('init_2').classList.remove('animate');

            document.getElementById('init_1').classList.add('active');
            break;
        case STATES.APPARITION:
            document.getElementById('init_2').classList.add('active');
            document.getElementById('init_2').classList.add('animate');
            break;
        case STATES.LISTENING:
            document.getElementById('init_1').classList.remove('active');
            document.getElementById('init_2').classList.remove('active');
            document.getElementById('init_2').classList.remove('animate');

            document.getElementById('ear').classList.remove('active');
            document.getElementById('ear').classList.remove('animate');

            document.getElementById('eyes').classList.add('active');
            document.getElementById('mouth').classList.add('active');
            document.getElementById('bg').classList.add('active');

            document.getElementById('eyes').classList.remove('animate');
            document.getElementById('mouth').classList.remove('animate');
            break;
        case STATES.EARING:
            document.getElementById('ear').classList.add('active');
            document.getElementById('ear').classList.add('animate');
            break;
        case STATES.THINKING:
            document.getElementById('ear').classList.remove('active');
            document.getElementById('ear').classList.remove('animate');

            document.getElementById('eyes').classList.add('animate');
            break;
        case STATES.TALKING:
            document.getElementById('ear').classList.remove('active');
            document.getElementById('ear').classList.remove('animate');
            document.getElementById('eyes').classList.remove('animate');

            document.getElementById('mouth').classList.add('animate');
            break;
        case STATES.GOODBYE:
            document.getElementById('eyes').classList.remove('active');
            document.getElementById('eyes').classList.remove('animate');
            document.getElementById('bg').classList.remove('active');

            document.getElementById('init_2').classList.add('active');
            document.getElementById('init_2').classList.add('animate');
            break;
    }
}


export function interpretAnswer(gptAnswer) {

    if (gptAnswer.toLowerCase().includes('whouu')) {
        displayState(STATES.APPARITION);
    }

    if (gptAnswer.toLowerCase().includes('hooo')) {
        displayState(STATES.GOODBYE);
    }

    playAudio();
}

var audio = document.getElementById('audio');

audio.addEventListener('ended', function () {

    if (currentState === STATES.GOODBYE) {
        displayState(STATES.INIT);
    } else {
        displayState(STATES.LISTENING);
    }

    startSpeechRecognition();
});

audio.addEventListener('play', function () {
    
    if (currentState !== STATES.GOODBYE ) {
        displayState(STATES.TALKING);
    }
    
    stopSpeechRecognition();
});


export function playAudio() {
    audio.src = 'chat/complete/mp3/'+Math.random().toString(36).substring(7)+'.mp3';
    audio.play();
}

export var currentState = STATES.INIT;
