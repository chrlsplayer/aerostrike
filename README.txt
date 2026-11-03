AEROSTRIKE - multiplayer test server
======================================

START
1. Double-click start.bat. A black window opens (the server) and your browser
   opens the game at http://localhost:3000.
2. In the game, click Multiplayer, then Connect.
3. Keep the black window open while you play. Close it to stop the server.

TEST WITH YOURSELF
Open a second browser window at http://localhost:3000 and connect again.
You now have two players. (Tip: give one of them a different name in Skins.)

PLAY WITH FRIENDS ON THE SAME WI-FI
The black window prints a line like "Friends on your Wi-Fi: http://192.168.x.x:3000".
Friends open that address in their browser and click Multiplayer > Connect.
The first time, Windows may ask whether to allow Node.js through the firewall -
click Allow (Private networks).

HOST
The first player to join is the host (star). The host picks the map, the mode
(Free-for-all or Team Deathmatch), the kill limit and how many bots (0-6), then
presses START MATCH. Bots run on the host's PC, so if the host leaves, the bots leave too.

UPDATING
When Claude updates the game, close the black server window and run start.bat
again so the new server is used, then refresh the browser page.

FILES
server.js          the game server (no extra installs needed)
public/index.html  the game itself
start.bat          starts everything

Playing with friends over the internet (not on your Wi-Fi) needs the server
hosted online - that is the next step.
