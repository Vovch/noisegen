document.addEventListener('DOMContentLoaded', () => {
    // Register the service worker for PWA functionality
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/service-worker.js')
            .then(registration => console.log('Service Worker registered with scope:', registration.scope))
            .catch(error => console.error('Service Worker registration failed:', error));
    }

    const noiseButtons = document.querySelectorAll('.noise-btn');
    const playPauseButton = document.getElementById('play-pause-btn');
    const statusText = document.getElementById('status-text');

    let audioContext;
    let noiseNode;
    let selectedNoise = null;
    let isPlaying = false;
    const bufferSize = 4096;

    // Web Audio API state variables for different noise colors
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0; // For Pink Noise
    let lastOut = 0; // For Brown Noise
    let lastIn = 0; // For Purple Noise

    const initializeAudio = () => {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
    };
    
    const createNoiseNode = () => {
        // Use the deprecated ScriptProcessorNode for wider compatibility in a simple demo.
        // For production, AudioWorklet is recommended for performance.
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
        if (!selectedNoise) return;

        initializeAudio();
        
        // Ensure audio context is running (required by modern browsers)
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }

        if (noiseNode) {
            noiseNode.disconnect();
        }

        noiseNode = createNoiseNode();
        noiseNode.connect(audioContext.destination);
        isPlaying = true;
        playPauseButton.textContent = 'Pause';
        statusText.textContent = `Playing ${selectedNoise.charAt(0).toUpperCase() + selectedNoise.slice(1)} Noise`;
    };


    const stopNoise = () => {
        if (noiseNode) {
            noiseNode.disconnect();
            // We don't destroy the node, just disconnect
        }
        if (audioContext && audioContext.state === 'running') {
            audioContext.suspend(); // More efficient than closing/re-opening
        }
        isPlaying = false;
        playPauseButton.textContent = 'Play';
        statusText.textContent = `${selectedNoise.charAt(0).toUpperCase() + selectedNoise.slice(1)} Noise selected`;
    };

    noiseButtons.forEach(button => {
        button.addEventListener('click', () => {
            // Deactivate other buttons
            noiseButtons.forEach(btn => btn.classList.remove('active'));
            // Activate clicked button
            button.classList.add('active');
            
            selectedNoise = button.dataset.noise;
            playPauseButton.disabled = false;
            
            if (isPlaying) {
                playNoise(); // Switch noise type while playing
            } else {
                stopNoise(); // Update text
            }
        });
    });

    playPauseButton.addEventListener('click', () => {
        if (!selectedNoise) return;

        if (isPlaying) {
            stopNoise();
        } else {
            playNoise();
        }
    });
});
