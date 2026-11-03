import { Anchor, Divider, Group, Text } from "@mantine/core";
import React from "react";
import { PageResponse } from "../api/model";
import { Link } from "react-router-dom";
import { PageArticleContent } from "./page-article-content";

export const CategoryGuide: React.FC<{
  pages: PageResponse[];
  categorySlug: string;
}> = ({ pages, categorySlug }) => {
  return (
    <>
      {pages.map((page, index) => (
        <React.Fragment key={page.slug}>
          {index > 0 && <Divider my="lg" />}
          <Group justify="space-between" mb="sm">
            <Text fw={600}>{page.title}</Text>
            <Group gap="sm">
              <Anchor
                component={Link}
                to={`/guide/${page.slug}/history`}
                size="sm"
              >
                <Text c="dimmed" size="sm">
                  {page.revision_count} revisions
                </Text>
              </Anchor>
              <Anchor
                component={Link}
                to={`/guide/${page.slug}/edit?from=category&category=${encodeURIComponent(categorySlug)}`}
                size="sm"
              >
                Edit
              </Anchor>
            </Group>
          </Group>
          <PageArticleContent page={page} />
        </React.Fragment>
      ))}
    </>
  );
};
