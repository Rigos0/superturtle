import { mockUser } from "./user";

const createMockTimestamp = (minutesAgo) => ({
  toDate: () => new Date(Date.now() - minutesAgo * 60 * 1000),
});

export const mockUsers = {
  tadeas: {
    username: mockUser.displayName,
    profile: mockUser.photoURL,
    title: mockUser.title,
  },
  avery: {
    username: "Avery Chen",
    profile: "https://i.pravatar.cc/200?img=12",
    title: "Design Systems Lead @ Figma's Fever Dream",
  },
  devin: {
    username: "Devin Carter",
    profile: "https://i.pravatar.cc/200?img=33",
    title: "Frontend Engineer | div Alignment Specialist",
  },
  sofia: {
    username: "Sofia Morales",
    profile: "https://i.pravatar.cc/200?img=44",
    title: "Product Marketing | Making Decks Nobody Reads",
  },
};

export const mockPosts = [
  {
    id: "mock-post-1",
    data: {
      profile: mockUsers.tadeas.profile,
      username: mockUsers.tadeas.username,
      timestamp: createMockTimestamp(8),
      description: "Thrilled to announce that ReKrabice just hit 10,000 boxes returned. That's 10,000 cardboard boxes that didn't end up crying alone in a recycling bin. We're literally saving relationships between humans and packaging. 📦♻️\n\n#sustainability #circulareconomy #boxes #humblebragging",
      fileType: null,
      fileData: null,
    },
  },
  {
    id: "mock-post-2",
    data: {
      profile: mockUsers.avery.profile,
      username: mockUsers.avery.username,
      timestamp: createMockTimestamp(17),
      description: "Hot take: your design system is not a product. It's a coping mechanism for the fact that your 47 designers can't agree on border-radius. Anyway here's a new icon set I made instead of going to therapy 🎨",
      fileType: "image",
      fileData: "https://picsum.photos/id/1015/1200/700",
    },
  },
  {
    id: "mock-post-3",
    data: {
      profile: mockUsers.devin.profile,
      username: mockUsers.devin.username,
      timestamp: createMockTimestamp(35),
      description: "Day 847 of centering a div. It's centered now. I think. The tests say yes. My eyes say maybe. The designer says 'can you move it 1px to the left?' I am at peace with the void between pixels. 🧘‍♂️",
      fileType: null,
      fileData: null,
    },
  },
  {
    id: "mock-post-4",
    data: {
      profile: mockUsers.sofia.profile,
      username: mockUsers.sofia.username,
      timestamp: createMockTimestamp(62),
      description: "Just finished 12 customer interviews. Key insight: users don't read onboarding flows. Secondary insight: users don't read anything. Third insight: I'm basically writing fan fiction for a product no one reads. Updating the deck anyway. 📊",
      fileType: null,
      fileData: null,
    },
  },
  {
    id: "mock-post-5",
    data: {
      profile: mockUsers.tadeas.profile,
      username: mockUsers.tadeas.username,
      timestamp: createMockTimestamp(95),
      description: "People ask me: 'Tadeáš, why reusable boxes? Why not something cool like AI or crypto?'\n\nBecause when the robots take over and the blockchain collapses, you'll still need something to put your stuff in. And I'll be there. With a box. A very nice, reusable one. 📦\n\n#ReKrabice #ThinkInsideTheBox",
      fileType: "image",
      fileData: "https://picsum.photos/id/1025/1200/700",
    },
  },
  {
    id: "mock-post-6",
    data: {
      profile: mockUsers.avery.profile,
      username: mockUsers.avery.username,
      timestamp: createMockTimestamp(130),
      description: "Agree? 👇\n\nThe best design is invisible. The second best design is whatever ships before the CEO changes their mind on Friday at 4:47 PM.\n\nRepost if you've ever redesigned a feature that launched 3 hours later.",
      fileType: null,
      fileData: null,
    },
  },
  {
    id: "mock-post-7",
    data: {
      profile: mockUsers.devin.profile,
      username: mockUsers.devin.username,
      timestamp: createMockTimestamp(188),
      description: "Removed 2,000 lines of CSS today. The app looks exactly the same. I've either achieved mass enlightenment or broken something that won't surface until the demo with investors. Either way, deploying to prod. YOLO. 🚀",
      fileType: null,
      fileData: null,
    },
  },
  {
    id: "mock-post-8",
    data: {
      profile: mockUsers.sofia.profile,
      username: mockUsers.sofia.username,
      timestamp: createMockTimestamp(255),
      description: "Made a 73-slide deck for a feature that got killed in standup this morning. Converting it into a 'learnings document' so the pain has a purpose. If anyone needs a beautifully designed post-mortem for something that never lived, DM me. 💀📑",
      fileType: "image",
      fileData: "https://picsum.photos/id/1043/1200/700",
    },
  },
  {
    id: "mock-post-9",
    data: {
      profile: mockUsers.tadeas.profile,
      username: mockUsers.tadeas.username,
      timestamp: createMockTimestamp(320),
      description: "I used to be EA to the CEO of Slevomat. My greatest achievement was protecting a 45-minute lunch block on his calendar for 6 consecutive months. Generals wish they had my strategic planning skills.\n\nNow I co-founded a box company. Some would call that a lateral move. I call it an upgrade. Boxes > calendars. Always. 📦 > 📅",
      fileType: null,
      fileData: null,
    },
  },
];
