document.addEventListener('DOMContentLoaded', () => {
    // Debug info for Safari troubleshooting
    console.log('Browser info:', {
        userAgent: navigator.userAgent,
        audioContext: !!(window.AudioContext || window.webkitAudioContext),
        serviceWorker: !!navigator.serviceWorker
    });

    // Register the service worker for PWA functionality
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./service-worker.js')
            .then(registration => console.log('Service Worker registered with scope:', registration.scope))
            .catch(error => console.error('Service Worker registration failed:', error));
    }

    const noiseButtons = document.querySelectorAll('.noise-btn');
    const playPauseButton = document.getElementById('play-pause-btn');
    const statusText = document.getElementById('status-text');

    let audioContext;
    let noiseNode;
    let gainNode; // Use a single gain node
    let selectedNoise = null;
    let isPlaying = false;
    let userHasInteracted = false; // Track first user interaction for iOS
    const bufferSize = 4096;

    // Web Audio API state variables for different noise colors
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0; // For Pink Noise
    let lastOut = 0; // For Brown Noise
    let lastIn = 0; // For Purple Noise

    // Utility: Detect iOS/Safari
    function isIOS() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    }
   function isSafari() {
        return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    }

    // This function MUST be called from a direct, synchronous user event (e.g., 'click', 'touchend')
    const unlockAudio = () => {
        if (userHasInteracted || !audioContext) return; // Already unlocked or not ready
        if (audioContext.state === 'suspended') {
            audioContext.resume().then(() => {
                console.log('AudioContext resumed successfully.');
                userHasInteracted = true;
            }).catch(e => console.error('AudioContext resume failed:', e));
        } else {
            userHasInteracted = true;
        }
    };

    const initializeAudio = () => {
        if (audioContext) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) {
                console.error('Web Audio API is not supported in this browser.');
                statusText.textContent = 'Error: Audio not supported.';
                return;
            }
            audioContext = new AudioContext();
            gainNode = audioContext.createGain(); // Create the gain node once
            gainNode.gain.value = 0.5;
            gainNode.connect(audioContext.destination);
            console.log('AudioContext created, state:', audioContext.state);
        } catch (error) {
            console.error('Failed to initialize audio:', error);
            statusText.textContent = 'Error: Could not create audio.';
        }
    };
    
    const createNoiseNode = () => {
        // ScriptProcessorNode is deprecated but necessary for this implementation.
        // For production apps, AudioWorklet is the modern standard.
        const node = audioContext.createScriptProcessor(bufferSize, 1, 1);
        
        node.onaudioprocess = (e) => {
            const output = e.outputBuffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                let noise;
                switch (selectedNoise) {
                    case 'white':
                        noise = Math.random() * 2 - 1;
                        break;
                    case 'pink':
                        const white = Math.random() * 2 - 1;
                        b0 = 0.99886 * b0 + white * 0.0555179;
                        b1 = 0.99332 * b1 + white * 0.0750759;
                        b2 = 0.96900 * b2 + white * 0.1538520;
                        b3 = 0.86650 * b3 + white * 0.3104856;
                        b4 = 0.55000 * b4 + white * 0.5329522;
                        b5 = -0.7616 * b5 - white * 0.0168980;
                        noise = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
                        noise *= 0.11; // Adjust gain
                        b6 = white * 0.115926;
                        break;
                    case 'brown':
                        const brownWhite = Math.random() * 2 - 1;
                        lastOut = (lastOut + (0.02 * brownWhite)) / 1.02;
                        noise = lastOut;
                        noise *= 3.5; // Adjust gain
                        break;
                    case 'purple':
                        const purpleWhite = Math.random() * 2 - 1;
                        noise = purpleWhite - lastIn;
                        lastIn = purpleWhite;
                        noise *= 0.7; // Adjust gain
                        break;
                    default:
                        noise = 0;
                }
                 // Prevent clipping
                output[i] = Math.max(-1, Math.min(1, noise));
            }
        };
        return node;
    };

    const playNoise = () => {
        if (!selectedNoise || !audioContext) return;

        // Disconnect any existing node
        if (noiseNode) {
            noiseNode.disconnect();
        }

        noiseNode = createNoiseNode();
        noiseNode.connect(gainNode); // Connect to the persistent gain node

        isPlaying = true;
        playPauseButton.textContent = 'Pause';
        statusText.textContent = `Playing ${selectedNoise.charAt(0).toUpperCase() + selectedNoise.slice(1)} Noise`;
        console.log('Audio started successfully');
    };


    const stopNoise = () => {
        if (noiseNode) {
            noiseNode.disconnect();
            // We don't destroy the node, just disconnect
        }
        isPlaying = false;
        playPauseButton.textContent = 'Play';
        if (selectedNoise) {
            statusText.textContent = `${selectedNoise.charAt(0).toUpperCase() + selectedNoise.slice(1)} Noise selected`;
        }
    };

    noiseButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            e.preventDefault();

            // Initialize audio on the very first user interaction
            if (!audioContext) {
                initializeAudio();
            }
            unlockAudio(); // Attempt to unlock on every interaction until successful

            // Deactivate other buttons
            noiseButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            
            const newNoise = button.dataset.noise;
            if (selectedNoise !== newNoise) {
                selectedNoise = newNoise;
                // If already playing, switch the noise type immediately
                if (isPlaying) {
                    playNoise();
                } else {
                    // Update status text if not playing
                    statusText.textContent = `${selectedNoise.charAt(0).toUpperCase() + selectedNoise.slice(1)} Noise selected`;
                }
            }
            
            playPauseButton.disabled = false;
        });
    });

    playPauseButton.addEventListener('click', (e) => {
        e.preventDefault();
        if (!selectedNoise) return;

        // Initialize audio on the very first user interaction
        if (!audioContext) {
            initializeAudio();
        }
        unlockAudio(); // Attempt to unlock on every interaction until successful

        if (isPlaying) {
            stopNoise();
        } else {
            playNoise();
        }
    });
});