import React from "react";
import { Container, Text } from "@mantine/core";
import { useDeletePage, useGetPage, useListPages } from "../api/hooks/pages";
import { useNavigate, useParams } from "react-router";
import { PageArticle } from "../components/page-article";

const GuidePage: React.FC = () => {
  const { slug } = useParams() as { slug?: string };
  const { data: pages, refetch: refetchPages } = useListPages();
  const defaultPage = pages?.pages.find(page => page.categories.length === 0);
  const {
    data: page,
    isError,
    refetch,
  } = useGetPage(slug ?? defaultPage?.slug ?? "", {
    query: {
      enabled: !!slug || !!defaultPage,
    },
  });
  const parentPages = pages?.pages.filter(p => page?.parent === p.slug) ?? [];

  const navigate = useNavigate();

  const { mutate: deletePage } = useDeletePage({
    mutation: {
      onSuccess: () => {
        // Redirect to top guide
        void navigate("/guide");
        void refetchPages();
      },
    },
  });

  if (isError) {
    return (
      <Container size="xl">
        <Text>Error loading page</Text>
      </Container>
    );
  }

  return page && pages ? (
    <PageArticle
      key={page.slug}
      page={page}
      pages={pages}
      parentPages={parentPages}
      refetch={() => {
        void refetch();
        void refetchPages();
      }}
      onDelete={() => {
        deletePage({ slug: page.slug });
      }}
    />
  ) : (
    <div />
  );
};

export default GuidePage;
