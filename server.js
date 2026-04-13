// process.env.PORT allows cloud hosts (like Render) to assign their own port.
// If it runs locally, it will default to 3000.
const PORT = process.env.PORT || 3000;

// Initialize Socket.io and allow connections from any website origin
const io = require('socket.io')(3000, {
    cors: { origin: "*" } 
});

// --- GLOBAL GAME STATE MEMORY ---
// These objects keep track of data for every room playing the game simultaneously.
// The key is the roomCode (e.g., '12345'), and the value is the data for that room.
const roomHosts = {};       // Example: { '12345': 'socketIdOfHost' }
const roomPlayers = {};     // Example: { '12345': [{id: '...', username: 'Jose'}] }
const roomSubmissions = {}; // Array of all prompts written during the round
const roomTimers = {};      // Stores the setInterval ID so we can stop the clock early

console.log("Server running. Phase logic active.");

io.on('connection', (socket) => {
    
    // ==========================================
    // 1. LOBBY CREATION & JOINING
    // ==========================================

    // CREATE: Generates a new 5-digit code and makes the creator the Host
    socket.on('create-room', (data) => {
        const { username } = data;
        const roomCode = Math.floor(10000 + Math.random() * 90000).toString();
        
        socket.username = username; // Attach username to the socket object directly
        socket.myRoom = roomCode; // Remember which room this socket belongs to
        socket.join(roomCode);

        // Setup initial arrays for this new room
        roomHosts[roomCode] = socket.id;
        roomPlayers[roomCode] = [{ id: socket.id, username: username }];
        roomSubmissions[roomCode] = [];
        
        socket.emit('room-status', { code: roomCode, isHost: true });
        console.log(`${username} created room ${roomCode}`);
    });

    // JOIN: Adds player to an existing room if the code is valid
    socket.on('join-room', (data) => {
        const { username, code } = data;

        // Check if the room actually exists on the server
        if (io.sockets.adapter.rooms.has(code)) {
            socket.username = username; 
            socket.myRoom = code;
            socket.join(code);
            
            // Add this player to our list
            roomPlayers[code].push({ id: socket.id, username: username });
            
            socket.emit('room-status', { code: code, isHost: false });
            // Send message to everyone in the room EXCEPT the person who just joined
            io.to(code).emit('update-log', `${username} has joined the party!`);
        } else {
            // Room does not exist
            socket.emit('update-log', "Error: Room not found.");
        }
    });

    // ==========================================
    // 2. START GAME & TARGET MATH
    // ==========================================

    socket.on('start-game-request', (code) => {
        // Double check that the person asking to start is actually the host
    if (roomHosts[code] === socket.id) {
        const players = roomPlayers[code];
        
        // Minimum player check! Math breaks if there are fewer than 4 people.
        if (players.length < 4) {
            io.to(socket.id).emit('update-log', "You need at least 4 players to start!");
            return; 
        }
        
        // Randomize player order
        const shuffled = [...players].sort(() => Math.random() - 0.5);
        
        // Loop through each player and assign them 3 unique targets
        // using modulo math (%) to wrap around the array
        shuffled.forEach((player, i) => {
            const assignments = {
                qTarget: shuffled[(i + 1) % shuffled.length].username,
                dTarget: shuffled[(i + 2) % shuffled.length].username,
                gTarget: shuffled[(i + 3) % shuffled.length].username
            };

            // Send these specific targets directly to this specific player
            io.to(player.id).emit('navigate-to-writing', assignments);
        });

        // Start the 120-second timer
        let timeLeft = 60; 
        roomTimers[code] = setInterval(() => {
            timeLeft--;
            io.to(code).emit('timer-update', timeLeft); // Send the time to the players
            
            // Time's up! Stop the clock and force everyone to submit
            if (timeLeft <= 0) {
                clearInterval(roomTimers[code]);
                io.to(code).emit('force-submit'); // Tell everyone to put their pencils down
            }
        }, 1000); // 1000ms = 1 second
    }
});

    // ==========================================
    // 3. DATA COLLECTION & REVEALS
    // ==========================================
    socket.on('submit-all-prompts', (data) => {
        const code = socket.myRoom;
        
        // Push the 3 answers into the pool WITHOUT the sender's name (Anonymous!)
        roomSubmissions[code].push(
            { category: 'Question', target: data.qTarget, text: data.qText },
            { category: 'Dare', target: data.dTarget, text: data.dText },
            { category: 'Gossip', target: data.gTarget, text: data.gText }
        );

        // Check if we have received all expected answers (3 per player)
        const expectedTotal = roomPlayers[code].length * 3;
        
        if (roomSubmissions[code].length >= expectedTotal) {
            // Everyone finished! Stop the timer early.
            if (roomTimers[code]) clearInterval(roomTimers[code]); 
            
            // Shuffle the giant array of prompts so nobody knows who wrote what
            roomSubmissions[code].sort(() => Math.random() - 0.5);

            // Tell all clients to move to the Reveal screen
            io.to(code).emit('all-prompts-ready');
        }
    });

    // When the host clicks "Next Prompt"
    socket.on('next-reveal', () => {
        const code = socket.myRoom;
        
        // Check if there are still prompts left to read
        if (roomSubmissions[code] && roomSubmissions[code].length > 0) {
            // Pop the last prompt off the array and send it
            const prompt = roomSubmissions[code].pop();
            io.to(code).emit('display-result', prompt);
        } else {
            // Array is empty! Game over
            io.to(code).emit('game-over');
        }
    });

    // ==========================================
    // 4. PLAY AGAIN LOOP
    // ==========================================
    socket.on('play-again-request', () => {
        const code = socket.myRoom;
        if (roomHosts[code] === socket.id) {
            roomSubmissions[code] = []; // Clear the old prompts
            io.to(code).emit('reset-to-lobby'); // Send everyone back
        }
    });
    // ==========================================
    // 5. DISCONNECT & HOST MIGRATION LOGIC
    // ==========================================

    // Helper function that runs whether they click "Leave" or close their browser tab
    function handlePlayerLeaving(socket) {
        const code = socket.myRoom;
        if (!code || !roomPlayers[code]) return; // If they weren't in a valid room, do nothing

        // Remove the player from the room's array
        roomPlayers[code] = roomPlayers[code].filter(player => player.id !== socket.id);
        
        io.to(code).emit('update-log', `${socket.username} has left the party.`);

        // Check if the room is now completely empty
        if (roomPlayers[code].length === 0) {
            delete roomHosts[code];
            delete roomPlayers[code];
            delete roomSubmissions[code];
            if (roomTimers && roomTimers[code]) clearInterval(roomTimers[code]);
            console.log(`Room ${code} is empty and has been deleted.`);
        } 
        // If the room ISN'T empty, check if the person who left was the host
        else if (roomHosts[code] === socket.id) {
            // The crown passes to the first person remaining in the array
            const newHost = roomPlayers[code][0];
            roomHosts[code] = newHost.id;
            
            io.to(code).emit('update-log', `👑 ${newHost.username} is the new host!`);
            io.to(newHost.id).emit('you-are-new-host'); // Tell the specific user to update their UI
        }

        // Clean up the socket's memory
        socket.leave(code);
        socket.myRoom = null;
    }

    // Triggered when a player explicitly creates/joins a new room
    socket.on('leave-room', () => {
        handlePlayerLeaving(socket);
    });

    // Built-in Socket.IO event for when a user closes the tab or loses connection
    socket.on('disconnect', () => {
        handlePlayerLeaving(socket);
    });
});