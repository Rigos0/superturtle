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
    title: "Design Systems Lead",
  },
  devin: {
    username: "Devin Carter",
    profile: "https://i.pravatar.cc/200?img=33",
    title: "Frontend Engineer",
  },
  sofia: {
    username: "Sofia Morales",
    profile: "https://i.pravatar.cc/200?img=44",
    title: "Product Marketing Manager",
  },
};

export const mockPosts = [
  {
    id: "mock-post-1",
    data: {
      profile: mockUsers.tadeas.profile,
      username: mockUsers.tadeas.username,
      timestamp: createMockTimestamp(8),
      description: "Polished the profile card spacing and shipped it behind a feature flag.",
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
      description: "Drafted a new icon set for the messaging flow. Feedback welcome.",
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
      description: "Video placeholder: short walkthrough of keyboard shortcuts in the demo app.",
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
      description: "Customer interviews highlighted onboarding friction on the second step.",
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
      description: "Trying a cleaner hero layout in the demo feed and testing readability.",
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
      description: "Video placeholder: mock launch teaser clip for next sprint review.",
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
      description: "Cleaned up old CSS overrides and reduced style conflicts in navigation.",
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
      description: "Quick visual concept for the events module.",
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
      description: "Documented the demo-state constraints so contributors can avoid Firebase calls.",
      fileType: null,
      fileData: null,
    },
  },
];
