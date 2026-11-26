/**
 * Word lists for the mock. The real app uses the full BIP39 English list (recovery key, D-06) and the EFF long
 * list (passphrases, §9.10); the mock carries representative subsets of both (every word below is genuine).
 */

export const BIP39_SUBSET = `
abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid
acoustic acquire across action actor actress actual adapt address adjust admit adult advance advice aerobic affair
afford afraid again agent agree ahead aim air airport aisle alarm album alcohol alert alien allow almost alone alpha
already also alter always amateur amazing among amount amused analyst anchor ancient anger angle angry animal ankle
announce annual another answer antenna antique anxiety apart apology appear apple approve april arch arctic area arena
argue armed armor army around arrange arrest arrive arrow art artist artwork ask aspect assault asset assist assume
asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid
awake aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball bamboo banana banner bar
barely bargain barrel base basic basket battle beach bean beauty because become beef before begin behave behind
believe below belt bench benefit best betray better between beyond bicycle bid bike bind biology bird birth bitter
black blade blame blanket blast bleak bless blind blood blossom blouse blue blur blush board boat body boil bomb bone
bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass brave bread breeze brick
bridge brief bright bring brisk broccoli broken bronze broom brother brown brush bubble buddy budget buffalo build
bulb bulk bullet bundle bunker burden burger burst bus business busy butter buyer buzz cabbage cabin cable cactus cage
cake call calm camera camp canal cancel candy cannon canoe canvas canyon capable capital captain carbon card cargo
carpet carry cart case cash casino castle casual catalog catch category cattle caught cause caution cave ceiling
celery cement census century cereal certain chair chalk champion change chaos chapter charge chase chat cheap check
cheese chef cherry chest chicken chief child chimney choice choose chronic chuckle chunk churn cigar cinnamon circle
citizen city civil claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog
close cloth cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column
combine come comfort comic common company concert conduct confirm congress connect consider control convince cook
cool copper copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle
craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross crouch crowd
crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious current curtain curve cushion
custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris decade december decide
`
  .trim()
  .split(/\s+/);

export const EFF_SUBSET = `
abacus abdomen abiding ablaze abrasive abreast absentee absolute absurdly acclaim accolade acorn acoustics acrobat
activism actress acutely adapter adeptly adhesive admiral adorable advocate aerobics affidavit afterglow agility
aground airbag airfield airship alabaster album algebra alibi alkaline almanac aloha alphabet altitude amazingly
ambiance amulet anchovy anemone angelfish anthem antidote anvil apricot aquarium arbitrary arcade armchair aromatic
artichoke aspirin astronaut atlas atrium audacious avalanche avocado awning backpack badminton bagpipe balcony
ballpoint bamboo banister banjo barnacle barometer basil batch bauble beanstalk bedrock beehive begonia bellhop
bicycle binocular biscuit blissful blueberry bobsled bonfire bookcase boomerang botanist boulevard bouquet bracelet
breezy brigade brisket brochure buckwheat buffalo bungalow butterfly cabana cactus cadet calcium calendar camera
campfire canary candle canopy canteen capsule caramel caravan cardigan carnival cartwheel cascade cashew catalyst
cauldron cavalier celery cello ceramics chalkboard chamomile chandelier chapel charcoal chariot cheddar chestnut
chimney chipmunk chocolate cinnamon citadel clarinet clockwork cobalt coconut comet compass concerto confetti
coral cosmos cottage courtyard crayon crescent cricket crocus crossword cupcake cymbal daffodil dandelion daybreak
decimal delta denim dewdrop diploma dolphin doorbell dragonfly driftwood dumpling dynamo eclipse eggplant elbow
elephant elevator ember emerald encore envelope espresso evergreen falcon fanfare feather fiddle firefly flamingo
flannel fondue footpath fortune fountain foxglove freckles frisbee galaxy garnet gazebo geyser ginger glacier
globe gondola gourmet granola grapefruit gravity greenhouse guitar gumball habitat hammock harbor harmonica harvest
hazelnut hedgehog helium hemlock hibiscus hickory highland hologram honeybee horizon hummingbird iceberg igloo
impulse indigo inkwell island ivory jackpot jasmine javelin jigsaw jubilee juniper kaleidoscope kayak kettle
keyboard kiwi labyrinth lagoon lantern lavender lemonade lighthouse lilac limestone lobster lollipop lullaby
macaroni magnolia mandolin mango maple marathon marigold marmalade meadow melody meteor midnight mistletoe mosaic
mountain muffin nectar nightfall nutmeg oasis observatory octopus orchard origami ostrich otter outback paddle
pagoda palette panorama papaya parade parsley pastel peacock pebble pelican penguin peppermint pinecone pistachio
planet plaza pocket pomegranate porcupine postcard pretzel prism pumpkin quartz quiver raccoon radish rainbow
raspberry ravioli redwood rhubarb riverbed rocket rosemary saffron sailboat sandcastle sapphire satellite seashell
sequoia shamrock silhouette skylark snowflake sonnet sparrow spinach starfish sunflower sycamore tambourine tangerine
telescope thistle thunder toboggan topaz trapeze tulip tundra turquoise ukulele umbrella unicorn upbeat valley
velvet violin volcano waffle walnut waterfall whistle willow windmill wombat yodel zeppelin zigzag zucchini
`
  .trim()
  .split(/\s+/);
