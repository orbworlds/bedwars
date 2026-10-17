<p align="center">
  <a href="https://orbworlds.com/orb/bed-wars?utm_source=github&utm_medium=readme&utm_campaign=bedwars"><img src="docs/cover.webp" alt="Bed Wars" width="720"></a>
</p>

<h1 align="center">Bed Wars</h1>

<p align="center">Bed Wars in your browser, in one HTML file: bridge across, gear up, guard your bed and break theirs.</p>

<p align="center">
  <a href="https://orbworlds.com/orb/bed-wars?utm_source=github&utm_medium=readme&utm_campaign=bedwars"><img src="docs/play-on-orb.svg" alt="Play on Orb" height="40"></a>
  &nbsp;
  <a href="https://orbworlds.com/orb/bed-wars?remix&utm_source=github&utm_medium=readme&utm_campaign=bedwars"><img src="docs/remix-on-orb.svg" alt="Remix on Orb" height="40"></a>
</p>

<p align="center"><b><a href="https://orbworlds.com/orb/bed-wars?utm_source=github&utm_medium=readme&utm_campaign=bedwars">Play it now</a></b>: free, in your browser, on any device. No download, no account.</p>

---

Solo, Doubles, Trios and Squads on ten sky arenas, each a world of its own: bridge across, gear up, guard your bed and break theirs. Bots fill every empty seat. Meet friends in the lobby, run its parkour, and earn looks with daily quests, the login streak and a monthly Bed Pass.

- **Solo, Doubles, Trios and Squads** on ten sky arenas, each a world of its own.
- **Bots fill every empty seat**, so a match starts the moment you do.
- A lobby to meet friends in, with its own parkour.
- Daily quests, a login streak and a monthly **Bed Pass**; outfits, hats, kill effects and victory dances in the wardrobe.

**Controls:** WASD to move (double-tap W to sprint), mouse to look, click to hit and place blocks, Space to jump, Shift or C to sneak, B for the shop and team upgrades, G for emotes and quick chat. Phones and tablets play by touch.

## Remix it

Every game on [Orb](https://orbworlds.com/?utm_source=github&utm_medium=readme&utm_campaign=bedwars) can be remixed, and this one is no exception. Two ways:

**By talking.** Open [Bed Wars on Orb](https://orbworlds.com/orb/bed-wars?remix&utm_source=github&utm_medium=readme&utm_campaign=bedwars), tap **Make my own copy**, and say what to
change: "make the nights longer", "add a dragon boss", "turn it into a pirate game". Orb's AI
builds it while you watch, and your version gets its own link to share.

**In code.** Fork this repository and play it on your machine:

```bash
git clone https://github.com/<you>/bedwars && cd bedwars
npm start            # http://127.0.0.1:4242 (Node 20+, nothing to install)
```

Open a second tab, or press **+ Player**, and you are two players in the same game. Edit
`index.html` and the page reloads. When you have pushed your changes, `npm run share` prints a
link that opens your version on Orb, as a world of your own, credited as a remix of Bed Wars.

Made it better? Open a pull request: once it's merged here, it's live on Orb for everyone within
about a quarter of an hour.

## How it's made

The whole game is one file: `index.html`, 7,517 lines (588 KB) of HTML, CSS and
JavaScript, with [three.js](https://threejs.org) from a CDN. No build step, no dependencies.
It runs as an Orb world, using Orb's world SDK (`window.orb`, typed in
[`orb-kit/orb.d.ts`](orb-kit/orb.d.ts)):

- **Multiplayer** with `orb.room`: who is here, their state, messages
- **Invite links** with `orb.room.invite`, opening the game in the same room
- **Shared state** with `orb.store`: leaderboards and what everyone shares
- **A wardrobe** with `orb.shop`: looks bought with Orb credits (on Orb, what paid credits buy goes to the world’s maker)
- **Progress** in plain `localStorage`, which Orb saves per player and carries to their other devices

Outside Orb, `window.orb` doesn't exist, and the game still runs on its own: open `index.html`
in a browser for a single-player game. `npm start` runs it with the
[Orb kit](https://github.com/orbworlds/kit) instead, which gives it everything above on localhost.

## Contributing

This repository is where Bed Wars is made: fixes, new content and ideas are welcome as pull requests
(see [CONTRIBUTING.md](CONTRIBUTING.md)). Every pull request runs the game's browser tests; merged,
it goes live on Orb by itself.

## License

The code is [MIT](LICENSE). It embeds the [Pixelify Sans](https://fonts.google.com/specimen/Pixelify+Sans)
font (SIL Open Font License 1.1, The Pixelify Sans Project Authors). The Orb name and logo aren't
covered by the license.

---

<p align="center">Made with <a href="https://orbworlds.com/?utm_source=github&utm_medium=readme&utm_campaign=bedwars"><b>Orb</b></a>: make games and worlds by talking, play them with friends, remix anyone's.</p>
