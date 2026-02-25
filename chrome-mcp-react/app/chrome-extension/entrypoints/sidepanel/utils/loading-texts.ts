/**
 * Random loading texts
 * Used by TimelineStatusStep component to display fun waiting tips
 */

const loadingTexts = [
  // Classic gems
  "Should have been smooth and effortless",
  "Now it's a mad scramble",
  "I know you're in a hurry, but hold on",
  "Dog-paddling through the ocean of knowledge",
  "Let the bullets fly a little longer",
  "Hand-crafting your answer right now",
  "Little monsters are assembling",
  "Don't rush, already writing (creating new folder)",
  "Sweating bullets while thinking",
  "CPU is about to overheat",
  // Daily life vibes
  "Slow-roasting like artisan coffee, quality takes time",
  "Flipping the knowledge pancake",
  "A toast to ourselves, almost there",
  "Putting inspiration in the oven",
  "Let the answer steep a bit longer",
  "Maxing out the good vibes",
  "Knitting a sweater of words for you",
  // Wild imagination
  "Neurons are dancing",
  "Night owl deep in thought",
  "Coloring in the answer",
  "Frantically flipping through the knowledge base",
  "Brain circus is starting",
  "Squishing 0s and 1s together",
  "Charging up a big move",
  "Magnifying glass is foggy, wiping it off",
  "Trying to understand this wild request",
  // Fantasy
  "Casting a spell, do not disturb",
  "Awakening silicon friends",
  "Connecting to cyber wisdom",
  "Fellow traveler, please wait while I calculate",
  "Traversing the knowledge black hole",
  "Reverse-engineering human intent",
  "Crystal ball is a bit fuzzy, give it a tap",
  // Professional
  "Code running faster than a reporter",
  "Manager is online, please hold",
  "Galloping over at full speed",
  "Transporting knowledge at light speed",
  "The last piece of the puzzle",
  "Answer is about to wrap up",
  "Launch countdown",
  "Target locked",
];

/**
 * Get a random loading text
 */
export function getRandomLoadingText(): string {
  return loadingTexts[Math.floor(Math.random() * loadingTexts.length)];
}
