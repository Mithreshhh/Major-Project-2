# Test fixtures

Sample images for the face-detector tests. Fetched and converted by
`node scripts/fetch-fixtures.mjs`; committed so the tests run offline.

| File | Content | Role in the test | Source | Licence |
| --- | --- | --- | --- | --- |
| `astronaut.jpg` | Portrait of astronaut Eileen Collins | Exactly one face, centred in a known region | NASA photo via the scikit-image data repository (`astronaut.png`) | Public domain |
| `apollo11-crew.jpg` | Apollo 11 crew portrait | Exactly three faces | NASA via Wikimedia Commons (`Apollo_11_Crew.jpg`, 960 px thumbnail) | Public domain |
| `coffee.jpg` | Coffee cup on a table | True negative, zero faces | Rachel Michetti via the scikit-image data repository (`coffee.png`) | CC0 |
| `chelsea-cat.jpg` | Cat photo | Known confuser: a cat's face can trigger a human-face detector; 0 to 2 detections tolerated and logged | Stefan van der Walt via the scikit-image data repository (`chelsea.png`) | CC0 |

Annotated copies with detection boxes are written to `../output/` when the tests run.
