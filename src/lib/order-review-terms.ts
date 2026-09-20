import { createHash } from "node:crypto";
import { OrderPromiseError } from "./order-promise";

// Same published fields as the storefront legal-page renderer. Keep this query
// aligned with frontend src/lib/data/strapi/legal.ts; archive the source with the
// acceptance so a later CMS edit cannot rewrite the terms of an existing order.
const query = `
  query LegalPage($slug: String!) {
    legalPages(status: PUBLISHED, filters: { Slug: { eq: $slug } }) {
      Slug
      Title
      Hero {
        Eyebrow
        Headline
        Subhead
        Image {
          url
          name
          width
          height
          alternativeText
        }
        ImageAlt
        PrimaryCta {
          Text
          Url
        }
        SecondaryCta {
          Text
          Url
        }
      }
      Body {
        __typename
        ... on ComponentInfoSection {
          SectionTitle: Title
          SectionBody: Body
          SectionImage: Image {
            url
            name
            width
            height
            alternativeText
          }
          ImageAlt
          ImagePosition
        }
        ... on ComponentInfoFeatureGrid {
          Heading
          Intro
          Cards {
            Title
            Body
            Icon {
              url
              name
              width
              height
              alternativeText
            }
          }
        }
        ... on ComponentInfoImageBlock {
          BlockImage: Image {
            url
            name
            width
            height
            alternativeText
          }
          Alt
          Caption
          Width
        }
        ... on ComponentSharedRichText {
          body
        }
        ... on ComponentInfoTableBlock {
          Heading
          Intro
          Columns {
            Label
            Key
            Alignment
            IsPrimary
          }
          TableRows: Rows {
            Label
            Cells
          }
          MobilePresentation
          Caption
        }
        ... on ComponentInfoComparisonTable {
          Heading
          Intro
          DecisionLabel
          LeftOptionLabel
          RightOptionLabel
          ComparisonRows: Rows {
            Label
            LeftValue
            RightValue
          }
          Caption
        }
      }
      Content
      UpdatedAt: updatedAt
      SEO {
        metaTitle
        metaDescription
        canonicalUrl
      }
    }
  }
`;
export const FINAL_CHARGE_CONSENT_VERSION =
  "catch-weight-final-charge-2026-05-31";
export const FINAL_CHARGE_CONSENT_TEXT =
  "I agree that Griller's Pride will save my card today and charge the final order total when my order is packed and ready to leave.";
export const STAFF_CARD_CONSENT_VERSION = "staff-card-at-placement-2026-09-20";
export const STAFF_CARD_CONSENT_TEXT =
  "The customer authorizes the card payment for the reviewed order total now.";

export async function publishedSaleTerms(): Promise<{
  revision: string;
  document: Record<string, any>;
}> {
  try {
    const origin = process.env.STRAPI_URL?.replace(/\/+$/, "");
    if (!origin) throw new Error("unconfigured");
    const response = await fetch(`${origin}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.STRAPI_TOKEN
          ? { Authorization: `Bearer ${process.env.STRAPI_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ query, variables: { slug: "terms-of-sale" } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("unavailable");
    const raw = await response.text();
    if (raw.length > 250000) throw new Error("too large");
    const result = JSON.parse(raw);
    const pages = result.data?.legalPages;
    const document = pages?.[0];
    if (
      result.errors?.length ||
      pages?.length !== 1 ||
      document?.Slug !== "terms-of-sale" ||
      !document.Title ||
      !document.UpdatedAt ||
      !Number.isFinite(Date.parse(document.UpdatedAt)) ||
      !(document.Content?.length || document.Body?.length) ||
      /lorem ipsum/i.test(JSON.stringify(document))
    )
      throw new Error("incomplete");
    const revision =
      "strapi-sale-terms:" +
      createHash("sha256").update(JSON.stringify(document)).digest("hex");
    return { revision, document };
  } catch {
    throw new OrderPromiseError("order_review_terms_unavailable", 503);
  }
}
