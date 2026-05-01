# Testing session — 2026-04-30

Device: Pixel 10 Pro
Build: <commit/PR> Latest
Notes: <anything global about the session> Overall it worked well, but there were a few issues

---

ok here are a few screenshots with numbers in green in The top right corner of the screenshot. I'll use those numbers when I reference the images. there are some non page specific items as well. I'll cover those first

## non page specific feedback

1. background music

- The panels apparently have background music per panel as opposed to background music that is applied across a set of panels. this is problematic because every time I go to the next panel if it has the same background music it just starts to track over. an example of this can be found in in issue 1 page 5, it has some action background music but every time I click another panel The same background music starts over

- we should add some logic that Can assign the background music to a set of panels which would be especially useful for an action sequence that spans multiple panels and potentially even more than one page. if the action sequence spans on to the next page maybe we could do something like pick back up the track where it left off on the previous page? they're resuming the track at the exact spot that it left at is not super high priority.

2. transitioning to next page

- currently when the user goes to the next page, they have to re-enable the panel by panel mode. I know that audio has limitations on auto playing but I should still be in the same reading mode on the next page

3. panels are out of order

- I have an example of this in the photos as well. this happened on issue one page 5 I believe.

- we need to either have the roboflow workflow properly put the panels in order or write some custom comparison logic (ie top left corner, bottom right corner, book reads left to right top to bottom)

4. particle effects

- The particle effects look neat in most places and wrong or just clunky in others. Ill discuss this more in details below.

5. bottom settings / control panel

- The bottom settings / control panel is a bit of a mess now with all the new features.
- I did a little research on how the kindle app works on my phone with comics and i saved those screenshots over in @feedback/screenshots/kindle. there is an /onboarding-flow folder and a /tmnt-mmpr-ii folder with a few pages from each.
- im less worried about the settings panel cleanup immediately, as that is more of a UI reorganization task
- i have an idea for how we can understant what the kindle app is doing and maybe use that to guide us in how we can improve the settings panel. more in the ideas section below.

## page specific feedback

### @feedback/screenshots/1.png

- The particle effect on this one seems weird because the lines are very clearly at the top of the page on the left and on the right, but the particle effect chosen was the spinny wheel in the middle. it seems like the correct choice would be to have the lines on the action lines animation in the upper left

- maybe we could add something to the Roboflow workflow to detect the action lines location and use some image tool to figure out their color and then apply our lines over where the action lines are.

### @feedback/screenshots/2.0.png

- The particle effect are good enough here, this is showing the layout of the page so you can visualize the incorrect orer of the panels. the correct net panel should be @feedback/screenshots/2.2.png

### @feedback/screenshots/2.1.png

- this should be the 3rd frame in the scene, but the app renders it at order number twothis goes into the logic I discussed above about determining the corners and figuring out which one is further to the left and further up than the existing one.

### @feedback/screenshots/3.png

- Particle effects started out looking cool and then they turned into just a full oanel blurry mess on top of the characters. It also features the pinwheel animation, and that is not exactly what goes there. This is on Issue 1, page 4.
- The same logic, wondering about being able to add some type of motion to whatever the motion lines are. For example, this picture has the kick line from the Green Power Ranger.

## Ideas

- I was messaging one of the AI agents in the RoboFlow app and was curious how well it worked. I asked it some basic questions, and then I started answering it more in-depth questions. That conversation is over in @docs/roboflow/agent-convo.md.
- The conversation covers basically the hypothetical thought of how do we get the particle effects to be layered into the page such that the characters and bubbles are not covered up.
- At the end of the document, I link to two other images that are the output of me testing the workflow that the agent added block to. It did some type of segmentation detection, and it somehow accurately highlighted and cut out every single character from issue 1, page 3.
- What are your thoughts on this?
  -- if it something we could pull off?
  -- is there another way to handle this / different approach?
  -- seeing how the roboflow workflow can EXTREMEMLY accurately highlight and cut out characters and tag faces, (i didnt spend any time training the node it added, it just worked out of the box) do you think the character lookahead we discussed is more possible now?
  -- since the segmentation detection is so accurate. Do you think we could use it to identify the lines of the actions or something and basically give us a dedicated area to apply action lines that would not get in the way of the characters and bubbles? Smoke is a different issue to handle, as it relies on knowing the depth of the smoke and the characters and bubbles (unless the smoke is actually in the foreground, we would have to have the smoke travel around where the bubbles are so it's possible to read it.)

### Kindle app research

- maybe we could use Ghidra/ IDA Pro to reverse engineer the kindle app and see how it works under the hood and see how they are handling the transitions to the next panel because they have an extremely smooth panel transition (sliding etc)
- im sure they have some fancy way to ingest their comics becuase its amazon and they have a lot of resources to do so.
- but since we already have a flow, being able to borrow their mechanics to create a similar experience would be a huge win amd save us some headache.
- actually, i was checking with gemini about if IDA worked with native mac apps and we were able to determine that i dont need Ghidra or IDA, we found that it is swift and gave me some info about how to use it. That is in @docs/kindle/inspect-mac-app.md (just ignore the incorrect things it said about my use of roboflow - it doesnt know the whole picture)
