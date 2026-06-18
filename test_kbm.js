const WebSocket = require('ws');

// 1. Connect as Host to grant KBM permissions
const hostWs = new WebSocket('ws://localhost:3000/ws/host');
hostWs.on('open', () => {
    console.log("[Host] Connected to /ws/host");
    
    // Tell the server we are the host
    hostWs.send(JSON.stringify({ type: 'identify', isHost: true }));
    
    // Grant kb permissions to v1_0 via the correct mode
    hostWs.send(JSON.stringify({
        type: 'set-input-mode',
        viewerId: 'v1_0',
        mode: 'kbm_emulated'
    }));
    console.log("[Host] Granted KBM permissions to v1_0");

    // 2. Connect as Input Client
    setTimeout(() => {
        const clientWs = new WebSocket('ws://localhost:3000/ws/input');
        clientWs.on('open', () => {
            console.log("[Client] Connected to /ws/input");
            
            // Identify as v1_0
            clientWs.send(JSON.stringify({ type: 'identify', viewerId: 'v1_0' }));
            
            // Send the W keydown event
            setTimeout(() => {
                const payload = {
                    event: 'keydown',
                    key: 'KEY_W',
                    type: 'keyboard',
                    viewerId: 'v1_0',
                    pad_id: 'v1_0'
                };
                console.log("[Client] Sending payload:", payload);
                clientWs.send(JSON.stringify(payload));
            }, 500);

            // Cleanup
            setTimeout(() => {
                clientWs.close();
                hostWs.close();
                console.log("Test finished.");
                process.exit(0);
            }, 1500);
        });
        clientWs.on('error', (err) => console.error("[Client] Error:", err));
    }, 500);
});
hostWs.on('error', (err) => console.error("[Host] Error:", err));
