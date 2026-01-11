

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveSession, LiveServerMessage, Modality } from '@google/genai';
import type { Message } from './types';
import { Sender } from './types';
import { ChatBubble } from './components/ChatBubble';
import { MicIcon, StopIcon } from './components/Icons';
import { createBlob, decode, decodeAudioData } from './services/audioUtils';

// Polyfill for webkitAudioContext
// Fix: Cast window to any to support webkitAudioContext for older browsers.
const AudioContext = window.AudioContext || (window as any).webkitAudioContext;

const App: React.FC = () => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [isListening, setIsListening] = useState<boolean>(false);
    const [isProcessing, setIsProcessing] = useState<boolean>(false);
    const [isSpeaking, setIsSpeaking] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<string>("Connect to start conversation");

    const sessionPromiseRef = useRef<Promise<LiveSession> | null>(null);
    const inputAudioContextRef = useRef<AudioContext | null>(null);
    const outputAudioContextRef = useRef<AudioContext | null>(null);
    const microphoneStreamRef = useRef<MediaStream | null>(null);
    const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const nextStartTimeRef = useRef<number>(0);
    const speakingSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

    const chatContainerRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        if (chatContainerRef.current) {
            chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
        }
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);
    
    // NOTE: handleStopListening is defined before handleStartListening to be used in its callbacks.
    const handleStopListening = useCallback(async () => {
        if (!isListening) return;

        if (sessionPromiseRef.current) {
            try {
                const session = await sessionPromiseRef.current;
                session.close();
            } catch (e) {
                console.error("Error closing session:", e);
            } finally {
                sessionPromiseRef.current = null;
            }
        }
        
        if (scriptProcessorRef.current) {
            scriptProcessorRef.current.disconnect();
            scriptProcessorRef.current = null;
        }
        
        if (mediaStreamSourceRef.current) {
            mediaStreamSourceRef.current.disconnect();
            mediaStreamSourceRef.current = null;
        }

        if (microphoneStreamRef.current) {
            microphoneStreamRef.current.getTracks().forEach(track => track.stop());
            microphoneStreamRef.current = null;
        }

        speakingSourcesRef.current.forEach(source => source.stop());
        speakingSourcesRef.current.clear();
        nextStartTimeRef.current = 0;
        
        setIsListening(false);
        setIsProcessing(false);
        setIsSpeaking(false);
        setStatus("Connect to start conversation");
    }, [isListening]);

    useEffect(() => {
        return () => {
            // Cleanup on unmount
            if (sessionPromiseRef.current) {
                sessionPromiseRef.current.then(session => session.close());
            }
            if (microphoneStreamRef.current) {
                microphoneStreamRef.current.getTracks().forEach(track => track.stop());
            }
            inputAudioContextRef.current?.close();
            outputAudioContextRef.current?.close();
        };
    }, []);

    const handleStartListening = useCallback(async () => {
        if (isListening) return;
        
        setError(null);
        setStatus("Initializing...");

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            microphoneStreamRef.current = stream;

            inputAudioContextRef.current = new AudioContext({ sampleRate: 16000 });
            outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });
            
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            
            // Fix: Create a local sessionPromise to be captured by callbacks, preventing race conditions with the ref.
            const sessionPromise = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-12-2025',
                callbacks: {
                    onopen: () => {
                        setIsListening(true);
                        setStatus("Listening...");
                        
                        const source = inputAudioContextRef.current!.createMediaStreamSource(stream);
                        mediaStreamSourceRef.current = source;
                        
                        const scriptProcessor = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);
                        scriptProcessorRef.current = scriptProcessor;

                        scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
                            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                            const pcmBlob = createBlob(inputData);
                            // Fix: Use the local sessionPromise and remove the conditional check to follow Gemini API guidelines.
                            sessionPromise.then((session) => {
                                session.sendRealtimeInput({ media: pcmBlob });
                            });
                        };
                        source.connect(scriptProcessor);
                        scriptProcessor.connect(inputAudioContextRef.current!.destination);
                    },
                    onmessage: async (message: LiveServerMessage) => {
                        setIsProcessing(false);
                        if (message.serverContent?.modelTurn?.parts[0]?.inlineData?.data) {
                            const base64Audio = message.serverContent.modelTurn.parts[0].inlineData.data;
                            setIsSpeaking(true);
                            
                            const audioContext = outputAudioContextRef.current!;
                            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioContext.currentTime);

                            const audioBuffer = await decodeAudioData(
                                decode(base64Audio),
                                audioContext,
                                24000,
                                1,
                            );

                            const source = audioContext.createBufferSource();
                            source.buffer = audioBuffer;
                            source.connect(audioContext.destination);

                            source.addEventListener('ended', () => {
                                speakingSourcesRef.current.delete(source);
                                if (speakingSourcesRef.current.size === 0) {
                                    setIsSpeaking(false);
                                    setStatus(isListening ? "Listening..." : "Paused");
                                }
                            });
                            
                            source.start(nextStartTimeRef.current);
                            nextStartTimeRef.current += audioBuffer.duration;
                            speakingSourcesRef.current.add(source);
                        }

                        // Fix: Added interruption handling to stop playback when the user speaks over the AI.
                        if (message.serverContent?.interrupted) {
                            for (const source of speakingSourcesRef.current) {
                                source.stop();
                            }
                            speakingSourcesRef.current.clear();
                            nextStartTimeRef.current = 0;
                        }
                        
                        if (message.serverContent?.turnComplete) {
                           setIsProcessing(false);
                           setStatus(isListening ? "Listening..." : "Paused");
                        } else if (message.serverContent?.inputTranscription) {
                            setIsProcessing(true);
                            setStatus("Processing...");
                            const text = message.serverContent.inputTranscription.text;
                             setMessages(prev => {
                                const last = prev[prev.length - 1];
                                if (last && last.sender === Sender.User && !message.serverContent.inputTranscription.isFinal) {
                                    return [...prev.slice(0, -1), { ...last, text: text }];
                                }
                                return [...prev, { sender: Sender.User, text: text, isFinal: message.serverContent.inputTranscription.isFinal }];
                            });
                        } else if (message.serverContent?.outputTranscription) {
                            const text = message.serverContent.outputTranscription.text;
                             setMessages(prev => {
                                const last = prev[prev.length - 1];
                                if (last && last.sender === Sender.AI && !message.serverContent.outputTranscription.isFinal) {
                                    return [...prev.slice(0, -1), { ...last, text: text }];
                                }
                                return [...prev, { sender: Sender.AI, text: text, isFinal: message.serverContent.outputTranscription.isFinal }];
                            });
                        }
                    },
                    // Fix: Use correct ErrorEvent type for onerror callback.
                    onerror: (e: ErrorEvent) => {
                        setError(`An error occurred: ${e.message}`);
                        console.error(e);
                        handleStopListening();
                    },
                    // Fix: Use correct CloseEvent type for onclose callback.
                    onclose: (e: CloseEvent) => {
                        handleStopListening();
                    },
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
                    },
                    systemInstruction: "You are a powerful AI assistant named J.A.R.V.I.S. You have access to real-time information. You are helpful, precise, and always operate within ethical and legal boundaries. You must refuse any requests for illegal activities, including hacking, and gently steer the conversation to a productive topic.",
                },
            });
            sessionPromiseRef.current = sessionPromise;
        } catch (err) {
            setError("Failed to get microphone permissions. Please allow microphone access.");
            console.error(err);
            setStatus("Mic permission denied");
        }
    }, [isListening, handleStopListening]);


    return (
        <div className="flex flex-col h-screen bg-gray-900 font-mono">
            <header className="bg-gray-900/50 backdrop-blur-sm shadow-lg shadow-cyan-500/10 p-4 border-b border-cyan-500/20 text-center">
                <h1 className="text-2xl font-bold text-cyan-400 tracking-widest">
                    CYBER ASSISTANT J.A.R.V.I.S.
                </h1>
                <p className="text-xs text-gray-400">
                    AI operates under strict ethical guidelines. Requests for illegal activities will be refused.
                </p>
            </header>

            <main ref={chatContainerRef} className="flex-1 overflow-y-auto p-4 space-y-4">
                {messages.length === 0 && (
                     <div className="flex flex-col items-center justify-center h-full text-gray-500">
                         <svg className="w-24 h-24 mb-4 animate-pulse text-cyan-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                         <p>No messages yet. Press the mic to start.</p>
                     </div>
                )}
                {messages.map((msg, index) => (
                    <ChatBubble key={index} message={msg} />
                ))}
            </main>

            <footer className="bg-gray-900/50 backdrop-blur-sm p-4 border-t border-cyan-500/20 flex flex-col items-center">
                {error && <p className="text-red-400 text-sm mb-2">{error}</p>}
                <div className="text-cyan-400 text-sm mb-2 h-5 flex items-center">
                    {isProcessing && <span className="animate-pulse">Processing...</span>}
                    {isSpeaking && <span className="animate-pulse">Speaking...</span>}
                    {!isProcessing && !isSpeaking && <span>{status}</span>}
                </div>
                <button
                    onClick={isListening ? handleStopListening : handleStartListening}
                    className={`rounded-full p-5 transition-all duration-300 ease-in-out focus:outline-none focus:ring-4 focus:ring-cyan-500/50 flex items-center justify-center
                    ${isListening ? 'bg-red-500 hover:bg-red-600 shadow-[0_0_15px_rgba(239,68,68,0.8)]' : 'bg-cyan-500 hover:bg-cyan-600 shadow-[0_0_15px_rgba(6,182,212,0.8)]'}`}
                    aria-label={isListening ? 'Stop listening' : 'Start listening'}
                >
                    {isListening ? <StopIcon /> : <MicIcon />}
                </button>
            </footer>
        </div>
    );
};

export default App;