import type { Metadata } from "next";
import { PipelineStory } from "@/frontend/pipeline-story";
import "@/frontend/pipeline-story.css";

export const metadata: Metadata = {
  title: "How Logless works",
  description: "Follow the journey from private conversations to shared insights.",
};

export default function HowItWorksPage() {
  return <PipelineStory />;
}
