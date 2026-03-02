import ThumbUpAltIcon from "@material-ui/icons/ThumbUpAlt";
import FavoriteIcon from "@material-ui/icons/Favorite";
import EmojiEventsIcon from "@material-ui/icons/EmojiEvents";
import EmojiObjectsIcon from "@material-ui/icons/EmojiObjects";
import SentimentVerySatisfiedIcon from "@material-ui/icons/SentimentVerySatisfied";

export const REACTION_ITEMS = [
  {
    key: "like",
    label: "Like",
    color: "#2e7d32",
    Icon: ThumbUpAltIcon,
  },
  {
    key: "love",
    label: "Love",
    color: "#d32f2f",
    Icon: FavoriteIcon,
  },
  {
    key: "celebrate",
    label: "Celebrate",
    color: "#ed6c02",
    Icon: EmojiEventsIcon,
  },
  {
    key: "insightful",
    label: "Insightful",
    color: "#0288d1",
    Icon: EmojiObjectsIcon,
  },
  {
    key: "funny",
    label: "Funny",
    color: "#f9a825",
    Icon: SentimentVerySatisfiedIcon,
  },
];
