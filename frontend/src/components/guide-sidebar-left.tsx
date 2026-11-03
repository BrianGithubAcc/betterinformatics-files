import {
  Button,
  Group,
  Modal,
  Select,
  SegmentedControl,
  Stack,
  Switch,
  TextInput,
  Text,
  Tree,
  Anchor,
  Divider,
  TreeNodeData,
  RenderTreeNodePayload,
  UnstyledButton,
  useTree,
} from "@mantine/core";
import React, { useMemo, useState } from "react";
import { useRequest } from "ahooks";
import { useBICourseList } from "../api/hooks";
import { useCreatePage, useListPages } from "../api/hooks/pages";
import { fetchGet } from "../api/fetch-utils";
import { NavLink, useMatch, useNavigate } from "react-router-dom";
import {
  IconChevronRight,
  IconPlus,
  IconSquarePlus,
} from "@tabler/icons-react";
import style from "./guide-sidebar-left.module.css";
import { clsx } from "clsx";
import { Turnstile } from "@marsidev/react-turnstile";
import { useUser } from "../auth";
import { Kind, PageListResponseItem } from "../api/model";
import serverData from "../utils/server-data";

interface CategoryEuclidCode {
  code: string;
  category: string;
}

const loadCategoryEuclidCodes = async () =>
  (await fetchGet("/api/category/listeuclidcodes/")).value as
    CategoryEuclidCode[] | undefined;

const normaliseCode = (code: string | undefined) =>
  code?.trim().toUpperCase() ?? "";

interface GuideTreeNode extends TreeNodeData {
  // Year headings have no page slug.
  slug?: string;
  children?: GuideTreeNode[];
}
//Build tree from flat
const buildPageTree = (pages: PageListResponseItem[]): GuideTreeNode[] => {
  const nodes = new Map<string, GuideTreeNode>(
    pages.map(page => [
      page.slug,
      {
        value: page.slug,
        slug: page.slug,
        label: page.title,
      },
    ]),
  );
  const roots: GuideTreeNode[] = [];
  for (const page of pages) {
    const node = nodes.get(page.slug)!;
    const parent = page.parent ? nodes.get(page.parent) : undefined;
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
  }
  return roots;
};

// Collect this page and its ancestors, stopping if a cycle is found.
const getPageAncestors = (
  page: PageListResponseItem,
  pages: Map<string, PageListResponseItem>,
) => {
  const ancestors: PageListResponseItem[] = [];
  const visited = new Set<string>();
  let current: PageListResponseItem | undefined = page;
  while (current && !visited.has(current.slug)) {
    ancestors.push(current);
    visited.add(current.slug);
    current = current.parent ? pages.get(current.parent) : undefined;
  }
  return ancestors;
};

const LeafNode: React.FC<
  Omit<RenderTreeNodePayload, "node"> & { node: GuideTreeNode }
> = ({ node, expanded, hasChildren, elementProps, tree }) => {
  const route = useMatch("/guide/:slug");
  const match = !!node.slug && route?.params.slug === node.slug;

  const label = (
    <Group gap="xs" justify="space-between">
      <span className={style.ellipsis}>{node.label}</span>
      {hasChildren && (
        <IconChevronRight
          size={16}
          style={{
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.2s",
          }}
        />
      )}
    </Group>
  );
  if (!node.slug) {
    return (
      <UnstyledButton
        {...elementProps}
        aria-expanded={expanded}
        onClick={() => tree.toggleExpanded(node.value)}
      >
        {label}
      </UnstyledButton>
    );
  }

  return (
    <Anchor
      display="block"
      component={NavLink}
      to={`/guide/${node.slug}`}
      {...elementProps}
      // Keep expanded branches open when navigating to another page.
      onClick={_ => {
        if (hasChildren && (match || !expanded)) {
          tree.toggleExpanded(node.value);
        }
      }}
      className={clsx(
        style.treeNodeLink,
        match && style.active,
        elementProps.className,
      )}
    >
      {label}
    </Anchor>
  );
};

//Render course tree
const CourseTree: React.FC<{ data: GuideTreeNode[] }> = ({ data }) => {
  const tree = useTree({
    initialExpandedState: Object.fromEntries(
      data.map(node => [node.value, true]),
    ),
  });

  return (
    <Tree
      data={data}
      tree={tree}
      renderNode={payload => <LeafNode {...payload} />}
      classNames={{
        root: style.treeRoot,
        label: style.treeNodeLabel,
        subtree: style.treeSubtree,
      }}
    />
  );
};

export const GuideSideBarLeft: React.FC = () => {
  const user = useUser();
  const navigate = useNavigate();
  const [treeMode, setTreeMode] = useState<"main" | "courses">("main");

  const { data: pages, refetch: refetchPages } = useListPages();
  const [courseListError, courseListLoading, courseList] = useBICourseList();
  const { data: categoryEuclidCodes, loading: categoryEuclidCodesLoading } =
    useRequest(loadCategoryEuclidCodes, {
      cacheKey: "guide-sidebar-category-euclid-codes",
    });

  const { mainTreeData, courseTreeData } = useMemo(() => {
    const allPages = pages?.pages ?? [];
    const pageBySlug = new Map(allPages.map(page => [page.slug, page]));
    // Match primary and shadow EUCLID codes to their course year.
    const yearByCode = new Map<string, string>();
    for (const course of Object.values(courseList?.list ?? {})) {
      const year = course.year?.trim();
      if (!year) continue;
      for (const code of [course.euclid_code, course.euclid_code_shadow]) {
        const key = normaliseCode(code);
        if (key) yearByCode.set(key, year);
      }
    }

    // Use the first EUCLID code with a mapped year for each category.
    const yearByCategory = new Map<string, string>();
    for (const link of categoryEuclidCodes ?? []) {
      const year = yearByCode.get(normaliseCode(link.code));
      if (year && !yearByCategory.has(link.category)) {
        yearByCategory.set(link.category, year);
      }
    }
    const mainPages: PageListResponseItem[] = [];
    const courseGroups = new Map<string, PageListResponseItem[]>();

    for (const page of allPages) {
      const ancestors = getPageAncestors(page, pageBySlug);
      // If the page and all parents above have no category render it in the main tree.
      if (ancestors.every(ancestor => ancestor.categories.length === 0)) {
        mainPages.push(page);
        continue;
      }

      // The highest mapped ancestor determines the year for its whole subtree.
      const year = ancestors
        .toReversed()
        .flatMap(ancestor => ancestor.categories)
        .map(category => yearByCategory.get(category.slug))
        .find(year => year !== undefined);
      if (!year) continue;
      const group = courseGroups.get(year) ?? [];
      group.push(page);
      courseGroups.set(year, group);
    }

    return {
      mainTreeData: buildPageTree(mainPages),
      courseTreeData: Array.from(courseGroups)
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .map(([year, group]) => ({
          value: `year:${year}`,
          label: year === "P" ? "Postgraduate" : `Year ${year}`,
          children: buildPageTree(group),
        })),
    };
  }, [pages, categoryEuclidCodes, courseList]);

  const [isOpen, setIsOpen] = useState(false);
  const [newPageName, setNewPageName] = useState("");
  const [newPageParent, setNewPageParent] = useState<string | null>(null);
  const [newPageKind, setNewPageKind] = useState<Kind>("guide");
  const [newPageAnonymous, setNewPageAnonymous] = useState(false);

  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  const {
    mutate: createPage,
    isPending: createIsPending,
    isError: createIsError,
  } = useCreatePage({
    mutation: {
      onSuccess(data) {
        setIsOpen(false);
        setNewPageName("");
        setNewPageParent(null);
        setNewPageAnonymous(false);
        void refetchPages();
        void navigate(`/guide/${data.slug}`);
      },
    },
    request: {
      method: "POST",
      headers: {
        "X-Turnstile-Token": turnstileToken ?? "",
      },
    },
  });
  return (
    <>
      <Modal
        opened={isOpen}
        title="Create New Page"
        onClose={() => setIsOpen(false)}
      >
        <Stack>
          {createIsError && <Text c="red">Page could not be created.</Text>}
          <TextInput
            label="Page Name"
            placeholder="Guide to Edinburgh"
            value={newPageName}
            onChange={e => setNewPageName(e.currentTarget.value)}
          />
          <Select
            label="Parent Page"
            placeholder="No parent"
            clearable
            searchable
            data={pages?.pages.map(p => ({ value: p.slug, label: p.title }))}
            value={newPageParent}
            onChange={setNewPageParent}
          />
          <Group justify="space-between">
            <Switch
              label="Create Anonymously"
              checked={newPageAnonymous}
              onChange={() => setNewPageAnonymous(!newPageAnonymous)}
            />
            {user?.isAdmin && (
              <Switch
                label="Create Static HTML Page"
                checked={newPageKind === "static_html"}
                onChange={() =>
                  setNewPageKind(
                    newPageKind === "static_html" ? "guide" : "static_html",
                  )
                }
              />
            )}
          </Group>
          <Button
            disabled={createIsPending || newPageName.trim() === ""}
            onClick={() =>
              createPage({
                data: {
                  kind: newPageKind,
                  title: newPageName,
                  parent: newPageParent,
                  categories: [],
                  is_anonymous: newPageAnonymous,
                },
              })
            }
            leftSection={<IconPlus />}
            loading={createIsPending || (!user?.isAdmin && !turnstileToken)}
          >
            Add
          </Button>
          {!user?.isAdmin && (
            <Turnstile
              siteKey={serverData.turnstile_sitekey}
              onSuccess={setTurnstileToken}
              options={{
                action: "create_page",
              }}
            />
          )}
        </Stack>
      </Modal>
      <Stack
        gap="xs"
        pos={{ base: "relative", sm: "sticky" }}
        miw="200px"
        top={{ base: 0, sm: "4rem" }}
        w={{ base: "100%", sm: treeMode === "courses" ? "20rem" : "13.75rem" }}
        style={{ transition: "width 180ms ease" }}
      >
        <SegmentedControl
          fullWidth
          aria-label="Guide navigation"
          value={treeMode}
          onChange={value => setTreeMode(value as "main" | "courses")}
          data={[
            { label: "Main", value: "main" },
            { label: "Courses", value: "courses" },
          ]}
        />
        {treeMode === "main" ? (
          <Tree
            data={mainTreeData}
            renderNode={payload => <LeafNode {...payload} />}
            classNames={{
              root: style.treeRoot,
              label: style.treeNodeLabel,
              subtree: style.treeSubtree,
            }}
          />
        ) : courseListLoading || categoryEuclidCodesLoading ? (
          <Text size="sm" c="dimmed">
            Loading course years…
          </Text>
        ) : courseListError || !categoryEuclidCodes ? (
          <Text size="sm" c="red">
            Could not load course year data. Please refresh the page.
          </Text>
        ) : (
          <CourseTree data={courseTreeData} />
        )}
        <Divider my="md" />
        <Button
          onClick={() => setIsOpen(true)}
          size="compact-sm"
          variant="subtle"
          leftSection={<IconSquarePlus size={16} />}
          justify="flex-start"
        >
          Create New Page
        </Button>
      </Stack>
    </>
  );
};
