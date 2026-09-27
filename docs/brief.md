# logless

## Understand your users without reading their conversations.

**logless is an open-source web app that helps personal-AI-assistant product teams understand what people use their assistant for—and what isn't working—without employees inspecting private customer conversations.**

Think **Google Trends for internal usage data**, with fictional user stories that make aggregate findings tangible.

## Purpose

Our thesis is that personal assistants create a product-development dilemma: understanding users is essential to improving the product, but their conversations can contain deeply sensitive information. Teams need a way to learn from usage without making private transcripts part of routine product analysis.

logless answers two practical questions:

> **“What are people doing with our assistant?”**  
> **“What are they trying to do that isn't working?”**

The goal is to uncover unexpected workflows and recurring frustrations that help PMs shape the roadmap—not simply generate categories, sentiment scores, or another chatbot.

## Core loop

**Conversations → private facets → thematic clusters → explorable hierarchy → representative user story.**

1. **Extract facets.** GLM 5.3 turns conversations into private, structured summaries of users' goals, tasks, and observable friction. Friction includes explicit corrections, task-related complaints, and unresolved action errors. Unknown outcomes remain unknown; silence is not treated as success or failure.

2. **Discover themes and classify interactions.** GLM identifies themes from the data rather than relying on a predefined taxonomy. Jev assigns the abstracted interactions to those themes and evaluates friction signals in parallel.

3. **Describe and generalize clusters.** GLM produces descriptive titles and summaries that preserve the underlying needs and frustrations while removing or generalizing identifying details. Source conversations, individual facets, and intermediate clusters remain private.

4. **Build an explorable hierarchy.** Related clusters become broader categories and subthemes. Analysts see reviewed, generalized summaries supported by computed usage counts, shares, and friction indicators—not individual conversations.

5. **Generate a representative user story.** A button asks GLM to illustrate a selected finding through a fictional person: an invented name, what they want the assistant to accomplish, and their frustrations. The generator receives only approved aggregate evidence. Every story is clearly labeled **fictional—not a real customer or additional evidence**. Needs and gripes must be grounded in the finding; only the name and minimal scene-setting are invented.

## The PM experience

A PM opens a visual overview of how people use the assistant. They can browse themes or type a question such as **“What are people struggling to coordinate?”**

Jev highlights relevant published clusters. Selecting one reveals the common workflow, its prevalence, and the observed friction. Clicking **“Generate user story”** turns the finding into a concrete, relatable account of the user need.

Natural-language exploration navigates approved aggregate insights. It does not enable unrestricted questions over private records, and semantic relevance is not presented as a newly measured usage statistic.

The demonstration should make one progression unmistakable:

**Discover an unexpected workflow → understand recurring friction → make the user need tangible.**

## Privacy principle: preserve the signal, generalize the detail

Do not discard a useful finding solely because it is unusual. Prefer expressing it as a broader product need, removing distinctive circumstances, or incorporating it into a more general theme. Preserve the supporting evidence honestly: generalization must not inflate prevalence or turn a single observation into a widespread trend.

The employee-facing experience exposes no transcripts, individual-level summaries, or customer drill-downs. Automated processing still accesses source records; the prototype does not claim to hide them from infrastructure operators or inference providers.

**The prototype uses synthetic data only.** Anonymization and generalization are not a formal guarantee against re-identification. Real customer data requires further privacy evaluation before deployment.

## System

logless is a **compound AI system** with distinct responsibilities: GLM 5.3 orchestrates reasoning, discovery, and writing; Jev provides fast classification and semantic relevance; executed code computes the numerical evidence.

Vultr hosts the web app and VM-based control plane, centrally orchestrating work in isolated sandboxes. GLM uses Vultr Serverless Inference at `https://api.vultrinference.com/v1`; Jev uses TypeSafe's API, as approved by the organizer.

Agent-written analysis code runs in isolated containers or throwaway instances on Vultr, never inside the application process. It returns actual computed results rather than model-estimated numbers. Sandboxes enforce execution limits and are reset or destroyed after each task; API credentials remain outside them. Containment supports the product rather than becoming an extra workflow the PM must manage.[^challenge]

## Prototype scope and deliverables

The prototype supports **one pre-generated synthetic dataset**, a real discovery-and-classification pipeline, hierarchical exploration, aggregate friction evidence, and on-demand user stories. Discovery may run before the presentation; findings must come from the pipeline rather than hardcoded dashboard content.

Deliverables are the full-stack app, synthetic seed data, documented open-source repository, public demo URL, one-minute recording, and three-minute live demo. The recording includes a brief, clearly labeled containment demonstration, such as a runaway job stopped by its execution limit.[^challenge]

No imports, live integrations, arbitrary queries over private records, or customer simulation are required for the prototype.

## Future work

Add imports and integrations, continuous analysis and richer trends, more rigorous outcome measurement, and stronger privacy evaluation before handling real customer data. Later, turn approved findings into **synthetic customer scenarios and sandboxed product simulations** so teams can experience and reproduce customer problems, not merely understand them.

[^challenge]: Deployment and containment requirements: *CV Hackathon Challenge 1 — Agent Sandboxing*, pp. 1–4. The Jev API exception was confirmed by the project team.
