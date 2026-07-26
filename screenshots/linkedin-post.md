AI makes implementation cheap, which makes over-engineering tempting.

Story time:

While working on Pi-Bifrost, I noticed users had to keep jumping between their editor and the docs to understand the config.

As a UX/DX freak, my first thought was to build an LSP specifically for that one file.

I could have asked AI to help build it and probably had a prototype quickly.

But then I remembered JSON Schema.

The editor already knows how to use it for autocomplete, validation, allowed values, descriptions, and type hints.

So instead of adding a new language server, why not just use JSON Schema?

It doesn’t solve everything, and it doesn’t replace runtime validation.

But it removes most of the friction involved in editing the config.

A useful reminder:

AI can help us build things faster. It can also make us reach for solutions we didn’t need in the first place.

Sometimes the underrated feature is the better engineering decision.

Check out Pi-Bifrost:
https://iamaamir.github.io/pi-bifrost/

#SoftwareEngineering #DeveloperTools #DeveloperExperience #JSONSchema #TypeScript
