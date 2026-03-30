/**
 * tests/e2e/fixtures/test-data-factory.ts — Factories for E2E test data
 * All entity names include Date.now() to avoid collisions across test runs.
 */

const ts = () => Date.now();

export const TestData = {
  /** Generate a unique course payload */
  course(institutionId: string) {
    return {
      institution_id: institutionId,
      name: `__e2e_course_${ts()}__`,
    };
  },

  /** Generate a unique semester payload */
  semester(courseId: string) {
    return {
      course_id: courseId,
      name: `__e2e_semester_${ts()}__`,
    };
  },

  /** Generate a unique section payload */
  section(semesterId: string) {
    return {
      semester_id: semesterId,
      name: `__e2e_section_${ts()}__`,
    };
  },

  /** Generate a unique topic payload */
  topic(sectionId: string) {
    return {
      section_id: sectionId,
      name: `__e2e_topic_${ts()}__`,
    };
  },

  /** Generate a unique summary payload */
  summary(topicId: string) {
    return {
      topic_id: topicId,
      title: `__e2e_summary_${ts()}__`,
      content: "E2E test summary content.",
    };
  },

  /** Generate a unique keyword payload */
  keyword(summaryId: string) {
    return {
      summary_id: summaryId,
      name: `__e2e_keyword_${ts()}__`,
    };
  },

  /** Generate a unique flashcard payload */
  flashcard(summaryId: string, keywordId: string) {
    return {
      summary_id: summaryId,
      keyword_id: keywordId,
      front: `__e2e_front_${ts()}__`,
      back: `__e2e_back_${ts()}__`,
    };
  },

  /** Test user credentials from ENV */
  credentials() {
    return {
      adminEmail: Deno.env.get("TEST_ADMIN_EMAIL") ?? "",
      adminPassword: Deno.env.get("TEST_ADMIN_PASSWORD") ?? "",
      userEmail: Deno.env.get("TEST_USER_EMAIL") ?? "",
      userPassword: Deno.env.get("TEST_USER_PASSWORD") ?? "",
    };
  },
};
