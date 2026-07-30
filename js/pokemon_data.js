/* ==========================================================================
   PokAddicts - Static Reference Lists (conditions, grading companies,
   grades, sets, sealed product types) used across intake/trade forms.
   ========================================================================== */

const POKEMON_DB = {
  // Raw single condition scale (TCG standard 5-tier)
  rawConditions: [
    "Near Mint",
    "Lightly Played",
    "Moderately Played",
    "Heavily Played",
    "Damaged"
  ],

  // Grading companies offered when logging a graded slab
  gradingCompanies: ["PSA", "BGS", "CGC", "SGC", "TAG", "ACE", "ARS"],

  // Grade scale offered for graded slabs (highest first)
  slabGrades: ["10", "9.5", "9", "8.5", "8", "7.5", "7", "6", "5", "4", "3", "2", "1"],

  sets: [
    "Scarlet & Violet: 151",
    "Evolving Skies",
    "Crown Zenith",
    "Paldea Evolved",
    "Base Set (1999)",
    "Team Rocket (2000)",
    "Surging Sparks",
    "Prismatic Evolutions",
    "Brilliant Stars",
    "Lost Origin",
    "Chilling Reign",
    "Silver Tempest",
    "Cyber Judge (JP)"
  ],

  // Generic sealed-product catalog, offered as tap-to-pick options once a
  // set name is entered during Sealed Product intake.
  sealedProductTypes: [
    "Booster Box",
    "Elite Trainer Box",
    "Booster Bundle",
    "Special Collection",
    "Premium Collection (UPC)",
    "Blister Pack (3-Pack)",
    "Tin",
    "Booster Pack (Single)",
    "Other Sealed Product"
  ]
};

window.POKEMON_DB = POKEMON_DB;
