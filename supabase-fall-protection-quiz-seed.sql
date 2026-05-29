-- Restores the Fall Protection saved quiz for excourse7233@gmail.com.
-- This quiz is saved as a draft (is_active = false) so it appears in Load Saved Quiz Questions
-- without creating an active student quiz session.

do $$
declare
  owner_id uuid;
  quiz_id uuid;
  question_id uuid;
  question_item record;
  choice_item record;
begin
  select id
  into owner_id
  from auth.users
  where lower(email) = 'excourse7233@gmail.com'
  limit 1;

  if owner_id is null then
    raise exception 'Cannot seed Fall Protection quiz because excourse7233@gmail.com was not found in auth.users.';
  end if;

  delete from public.quiz_templates
  where owner_user_id = owner_id
    and course_name = 'Fall Protection'
    and quiz_title = 'Fall Protection Quiz';

  insert into public.quiz_templates (
    course_name,
    quiz_title,
    quiz_description,
    passing_score,
    quiz_duration_minutes,
    is_active,
    owner_user_id
  )
  values (
    'Fall Protection',
    'Fall Protection Quiz',
    'Fall Protection Quiz generic 9.2.2025.',
    80,
    30,
    false,
    owner_id
  )
  returning id into quiz_id;

  for question_item in
    select value, ordinality
    from jsonb_array_elements($json$
[
  {"type":"single_choice","text":"OSHA regulations require some type of fall protection above how many feet in residential construction?","choices":[["4'",false],["6'",true],["8'",false],["10'",false]]},
  {"type":"multiple_choice","text":"To make sure all PV projects are completed safely, employers should have policies and procedures which: (Choose three)","choices":[["Allow employees to plan ahead",true],["Provide necessary equipment to do job right",true],["Provide training to all workers",true],["Allow workers to work fast and profitably (or efficient)",false]]},
  {"type":"single_choice","text":"True or False: Electrocution is the leading cause of death in the construction industry.","choices":[["True",false],["False",true]]},
  {"type":"multiple_choice","text":"Fall protection systems can include which three of the following:","choices":[["Personal fall arrest systems",true],["Working on flat roofs only",false],["Guardrail systems",true],["Safety nets",true],["Off-site video monitoring",false]]},
  {"type":"multiple_choice","text":"Following OSHA 29 CFR 1926.502(d), choose the three components of a Personal Fall Arrest System from the list below:","choices":[["Hardhat",false],["Body harness",true],["Anchor",true],["ANSI approved work boots",false],["Lifeline",true],["Proper training",false]]},
  {"type":"multiple_choice","text":"A properly designed Personal Fall Arrest System must: (Choose three)","choices":[["Limit maximum arresting force on employee to 1,800 pounds when using a body harness.",true],["Be rigged such that an employee cannot fall more than 6 feet.",true],["Bring employee to complete stop and limit maximum deceleration distance employee travels to 3.5 feet.",true],["Allow for two people to anchor to the same point.",false],["Be the same for every solar installation.",false]]},
  {"type":"single_choice","text":"A safety anchor must have the capability of supporting at least how many pounds per employee attached?","choices":[["500",false],["1,000",false],["1,500",false],["3,000",false],["5,000",true]]},
  {"type":"single_choice","text":"True or False: A body harness used in a personal fall arrest system must have the attachment point located in the center of the wearer's back.","choices":[["True",true],["False",false]]},
  {"type":"multiple_choice","text":"A positioning device system shall: (Choose two)","choices":[["Allow PV installer to work with both hands free while leaning.",true],["Allow PV installers to accurately perform module layout and installation.",false],["Be rigged such that an employee cannot free fall more than 2 feet.",true],["Gently lower a worker to the ground from 10 feet or more.",false]]},
  {"type":"single_choice","text":"True or False: Roof anchors, dee-rings, and snaphooks with rust on them are not required to be removed from service.","choices":[["True",false],["False",true]]},
  {"type":"multiple_choice","text":"Choose two methods below used to prevent workers from falling more than 6 feet through a skylight.","choices":[["Safety net",false],["Guardrails",true],["Mechanically close the skylight",false],["Show location of ALL skylights on the building plans",false],["Personal fall arrest system",true]]},
  {"type":"single_choice","text":"True or False: Ropes or lanyards used as part of a fall protection system must be made from synthetic fibers.","choices":[["True",true],["False",false]]},
  {"type":"single_choice","text":"Dee-rings and snaphooks used in a personal fall arrest system must:","choices":[["Have a minimum tensile strength of 5000 pounds.",false],["Be proof-tested to minimum tensile load of 3,600 pounds.",false],["Be sized to be compatible to that which it is connected.",false],["All of the above",true]]},
  {"type":"single_choice","text":"After a worker has taken a fall on their personal fall arrest system, it:","choices":[["Is allowed to be continued to be used if it is clean.",false],["Must immediately be removed from service.",true],["Shall be praised for preventing further injury.",false],["Can be given to an entry-level employee.",false]]},
  {"type":"single_choice","text":"Where a PV installation crew is using vertical lifelines as part of their personal fall protection system:","choices":[["Each employee shall be attached to a separate lifeline.",true],["One body harness is allowed to be shared by two installers.",false],["The lifeline(s) are only required when climbing vertically up the ladder.",false],["The anchor the lifeline(s) is secured to must be designed to hold the weight of all workers.",false]]},
  {"type":"single_choice","text":"When inspecting fall protection equipment look for:","choices":[["Cuts, frays, holes or deterioration of webbing or rope.",false],["Deformation of buckles, dee-rings and snaphooks.",false],["Rust/corrosion, deformation or damage to anchors.",false],["All of the above",true]]}
]
$json$::jsonb) with ordinality
  loop
    insert into public.quiz_questions (
      quiz_template_id,
      question_text,
      question_type,
      sort_order
    )
    values (
      quiz_id,
      question_item.value ->> 'text',
      question_item.value ->> 'type',
      question_item.ordinality - 1
    )
    returning id into question_id;

    for choice_item in
      select value, ordinality
      from jsonb_array_elements(question_item.value -> 'choices') with ordinality
    loop
      insert into public.quiz_answer_choices (
        question_id,
        choice_text,
        is_correct,
        sort_order
      )
      values (
        question_id,
        choice_item.value ->> 0,
        (choice_item.value ->> 1)::boolean,
        choice_item.ordinality - 1
      );
    end loop;
  end loop;

  perform pg_notify('pgrst', 'reload schema');
end;
$$;
